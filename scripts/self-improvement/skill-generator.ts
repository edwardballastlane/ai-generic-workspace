#!/usr/bin/env ts-node
/**
 * Skill Generator (Voyager): Detect novel successful sessions and
 * auto-generate SKILL.md proposals.
 *
 * Algorithm:
 * 1. Summarize session, embed summary, search existing sessions
 * 2. If top-3 similarity < noveltyThreshold AND quality >= 7 → novel success
 * 3. Prompt Claude CLI to generate SKILL.md content
 * 4. Write to skill-candidates/ or auto-promote to .claude/skills/
 *
 * Usage:
 *   npm run self:propose-skills
 *   ts-node skill-generator.ts [session-file.json]
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { SkillCandidate, Config } from './types';
import * as claude from './claude-client';
import { embed } from '../shared/embedder';
import * as qdrant from './vector-client';

function findWorkspaceRoot(): string {
  if (process.env.WORKSPACE_ROOT) return process.env.WORKSPACE_ROOT;
  let current = process.cwd();
  for (let i = 0; i < 15; i++) {
    if (fs.existsSync(path.join(current, '.claude'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

const WORKSPACE_ROOT = findWorkspaceRoot();
const CONFIG_PATH = path.join(WORKSPACE_ROOT, 'scripts/self-improvement/config.json');
const CANDIDATES_DIR = path.join(WORKSPACE_ROOT, 'scripts/self-improvement/skill-candidates');
const SKILLS_DIR = path.join(WORKSPACE_ROOT, '.claude/skills');
const SKILL_STATE_PATH = path.join(WORKSPACE_ROOT, 'scripts/self-improvement/skill-state.json');

interface SkillState {
  processedSessions: Record<string, { date: string; proposed: boolean }>;
}

export function loadSkillState(): SkillState {
  try {
    return JSON.parse(fs.readFileSync(SKILL_STATE_PATH, 'utf8'));
  } catch {
    return { processedSessions: {} };
  }
}

export function saveSkillState(state: SkillState): void {
  fs.writeFileSync(SKILL_STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

function loadConfig(): Config {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

/**
 * Summarize a session file using Claude CLI.
 */
async function summarizeSession(sessionPath: string): Promise<string> {
  const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  const messages = (sessionData.messages as Array<Record<string, unknown>>) || [];

  // Extract text from messages
  const texts: string[] = [];
  for (const msg of messages) {
    const inner = (msg.message as Record<string, unknown>) || msg;
    const content = typeof inner.content === 'string'
      ? inner.content
      : JSON.stringify(inner.content || '');
    if (content && content.length > 20) {
      texts.push(content.substring(0, 300));
    }
  }

  const sessionText = texts.slice(0, 20).join('\n---\n');

  const prompt = `Summarize this developer assistant session in 2-3 sentences. Focus on what task was accomplished, what tools/technologies were used, and what the outcome was.

Session excerpts:
${sessionText.substring(0, 3000)}

Summary:`;

  return claude.generate(prompt);
}

/**
 * Estimate average quality of a session from its chunks in Qdrant.
 */
async function getSessionQuality(sessionId: string): Promise<number> {
  const points = await qdrant.scrollSessions(
    { must: [{ key: 'session_id', match: { value: sessionId } }] },
    100
  );

  const scores = points
    .map(p => p.payload.quality_score as number)
    .filter(s => s !== undefined && s !== null);

  if (scores.length === 0) return 5; // default
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

/**
 * Check if a session represents a novel success and propose a skill.
 */
export async function checkAndProposeSkill(sessionPath: string): Promise<SkillCandidate | null> {
  const config = loadConfig();
  const sessionId = path.basename(sessionPath, '.json');

  // Get session quality
  const quality = await getSessionQuality(sessionId);
  if (quality < config.qualityThresholdSuccess) return null;

  // Summarize and check novelty
  const summary = await summarizeSession(sessionPath);
  if (!summary || summary.length < 20) return null;

  const summaryEmbedding = await embed(summary);
  const similar = await qdrant.searchSessions(summaryEmbedding, 3);

  // Check novelty: if top results are too similar, it's not novel
  const avgSimilarity = similar.length > 0
    ? similar.reduce((sum, r) => sum + r.score, 0) / similar.length
    : 0;

  if (avgSimilarity >= config.noveltyThreshold) return null;

  console.log(`Novel success detected (novelty: ${(1 - avgSimilarity).toFixed(2)}, quality: ${quality.toFixed(1)})`);

  // Generate skill proposal
  const skillPrompt = `Based on this successful session, create a reusable SKILL.md for a Claude Code skill.

Session summary: ${summary}

Generate a SKILL.md file with this exact format:
---
name: <short-kebab-case-name>
description: <one-line description>
auto_activation:
  - <keyword1>
  - <keyword2>
---

# <Skill Name>

## When to Use
<when this skill is relevant>

## Instructions
<step-by-step instructions for the assistant>

## Verification
<how to verify the skill was applied correctly>

Return ONLY the SKILL.md content, nothing else.`;

  try {
    const skillMd = await claude.generate(skillPrompt);

    // Extract name from frontmatter
    const nameMatch = skillMd.match(/name:\s*(.+)/);
    const name = nameMatch
      ? nameMatch[1].trim().replace(/[^a-z0-9-]/g, '')
      : `skill-${sessionId.substring(0, 8)}`;

    const descMatch = skillMd.match(/description:\s*(.+)/);
    const description = descMatch ? descMatch[1].trim() : summary.substring(0, 100);

    const autoActivation: string[] = [];
    const activationMatch = skillMd.match(/auto_activation:\n((?:\s+-\s+.+\n?)*)/);
    if (activationMatch) {
      const lines = activationMatch[1].split('\n');
      for (const line of lines) {
        const m = line.match(/^\s+-\s+(.+)/);
        if (m) autoActivation.push(m[1].trim());
      }
    }

    const candidate: SkillCandidate = {
      name,
      description,
      status: 'proposed',
      skillMd,
      autoActivation,
      createdAt: new Date().toISOString(),
      sourceSessionId: sessionId,
      noveltyScore: 1 - avgSimilarity,
      qualityScore: quality,
    };

    // In autonomous mode: validate and auto-promote
    if (config.approvalMode === 'autonomous') {
      const valid = await validateSkill(candidate);
      if (valid) {
        promoteSkill(candidate);
        return candidate;
      }
    }

    // Stage candidate for review
    if (!fs.existsSync(CANDIDATES_DIR)) {
      fs.mkdirSync(CANDIDATES_DIR, { recursive: true });
    }
    fs.writeFileSync(
      path.join(CANDIDATES_DIR, `${name}.json`),
      JSON.stringify(candidate, null, 2)
    );
    console.log(`  Skill candidate staged: ${name}`);

    return candidate;
  } catch (err) {
    console.error(`Failed to generate skill:`, (err as Error).message);
    return null;
  }
}

/**
 * Validate a skill candidate doesn't duplicate existing skills.
 */
async function validateSkill(candidate: SkillCandidate): Promise<boolean> {
  // Check for existing skills with similar names
  if (fs.existsSync(SKILLS_DIR)) {
    const existing = fs.readdirSync(SKILLS_DIR).filter(d => {
      const skillPath = path.join(SKILLS_DIR, d, 'SKILL.md');
      return fs.existsSync(skillPath);
    });

    for (const dir of existing) {
      if (dir === candidate.name) return false; // exact duplicate
      const skillMd = fs.readFileSync(path.join(SKILLS_DIR, dir, 'SKILL.md'), 'utf8');
      // Simple text overlap check
      const descMatch = skillMd.match(/description:\s*(.+)/);
      if (descMatch) {
        const existingDesc = descMatch[1].toLowerCase();
        const newDesc = candidate.description.toLowerCase();
        // Very basic overlap check
        const words = newDesc.split(/\s+/);
        const overlap = words.filter(w => w.length > 3 && existingDesc.includes(w)).length;
        if (overlap > words.length * 0.6) return false;
      }
    }
  }

  return true;
}

/**
 * Promote a skill candidate to .claude/skills/.
 */
export function promoteSkill(candidate: SkillCandidate): void {
  const skillDir = path.join(SKILLS_DIR, candidate.name);
  if (!fs.existsSync(skillDir)) {
    fs.mkdirSync(skillDir, { recursive: true });
  }

  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), candidate.skillMd);

  // Git commit
  try {
    execFileSync('git', ['add', skillDir], { cwd: WORKSPACE_ROOT, stdio: 'pipe' });
    const subject = `chore(self-improve): add skill "${candidate.name}"`;
    const coAuthor = 'Co-Authored-By: Claude <noreply@anthropic.com>';
    execFileSync('git', ['commit', '-m', subject, '-m', coAuthor], {
      cwd: WORKSPACE_ROOT,
      stdio: 'pipe',
    });
    console.log(`  Skill promoted: ${candidate.name} → .claude/skills/${candidate.name}/`);
  } catch (err) {
    console.error('Git commit failed:', (err as Error).message);
  }

  // Remove candidate file if it exists
  const candidatePath = path.join(CANDIDATES_DIR, `${candidate.name}.json`);
  if (fs.existsSync(candidatePath)) {
    fs.unlinkSync(candidatePath);
  }
}

/**
 * Approve a skill candidate by name (for /approve-skill command).
 */
export function approveSkill(name: string): boolean {
  const candidatePath = path.join(CANDIDATES_DIR, `${name}.json`);
  if (!fs.existsSync(candidatePath)) {
    console.error(`Skill candidate not found: ${name}`);
    console.log('Available candidates:');
    if (fs.existsSync(CANDIDATES_DIR)) {
      for (const f of fs.readdirSync(CANDIDATES_DIR).filter(f => f.endsWith('.json'))) {
        console.log(`  - ${f.replace('.json', '')}`);
      }
    }
    return false;
  }

  const candidate: SkillCandidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  candidate.status = 'approved';
  promoteSkill(candidate);
  return true;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === 'approve') {
    const name = args[1];
    if (!name) {
      console.error('Usage: skill-generator.ts approve <skill-name>');
      process.exit(1);
    }
    approveSkill(name);
    return;
  }

  // Process a session for skill candidates
  const sessionPath = args[0];
  if (sessionPath && fs.existsSync(sessionPath)) {
    await checkAndProposeSkill(sessionPath);
    return;
  }

  // Process all sessions
  const sessionsDir = path.join(WORKSPACE_ROOT, '.claude/logs/sessions');
  if (!fs.existsSync(sessionsDir)) {
    console.log('No sessions directory found.');
    return;
  }

  console.log('Skill Generator (Voyager)');
  console.log('='.repeat(40));

  const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
  console.log(`Scanning ${files.length} session(s) for novel successes...\n`);

  let proposed = 0;
  for (const file of files) {
    try {
      const result = await checkAndProposeSkill(path.join(sessionsDir, file));
      if (result) proposed++;
    } catch { /* continue */ }
  }

  console.log(`\nDone. Proposed ${proposed} skill(s).`);
}

if (require.main === module) {
  main().catch(console.error);
}
