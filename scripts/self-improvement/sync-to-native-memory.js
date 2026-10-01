#!/usr/bin/env node
/**
 * sync-to-native-memory — Prototype: write high-confidence personal rules
 * to Claude Code's native memory path so CC's own compaction/loading handles them.
 *
 * Native memory path: ~/.claude/projects/<encoded-cwd>/memory/
 *   - Each rule becomes an individual file with YAML frontmatter
 *   - MEMORY.md is an index with one-line entries pointing at each file
 *
 * Trade-offs:
 *   - Native memory is PER-USER (path-based). Team rules stay in rules-shared.json.
 *   - Personal rules migrated here stop being injected by inject-rules.js (avoid double-load).
 *   - This is a PROTOTYPE — not wired into the hook chain yet. Safe to run.
 *
 * Usage:
 *   node scripts/self-improvement/sync-to-native-memory.js           # dry-run
 *   node scripts/self-improvement/sync-to-native-memory.js --apply   # actually write
 *   node scripts/self-improvement/sync-to-native-memory.js --clean   # remove all synced files
 *
 * Filter:
 *   Only active rules are synced. Override with env MIN_REINFORCEMENTS=N
 *   to require at least N reinforcements.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const MIN_REINFORCEMENTS = parseInt(process.env.MIN_REINFORCEMENTS || '0', 10);
const DRY_RUN = !process.argv.includes('--apply') && !process.argv.includes('--clean');
const CLEAN = process.argv.includes('--clean');

// Workspace root (directory containing CLAUDE.md)
function findWorkspaceRoot() {
  let current = __dirname;
  for (let i = 0; i < 15; i++) {
    if (fs.existsSync(path.join(current, 'CLAUDE.md'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

const WORKSPACE_ROOT = findWorkspaceRoot();
const PERSONAL_RULES_PATH = path.join(WORKSPACE_ROOT, 'scripts', 'self-improvement', 'rules.json');
const TEAM_RULES_PATH = path.join(WORKSPACE_ROOT, 'scripts', 'self-improvement', 'rules-shared.json');

// Native memory path: ~/.claude/projects/<encoded-cwd>/memory/
// Encoding: leading "-" + path with "/" replaced by "-"
const encodedCwd = '-' + WORKSPACE_ROOT.replace(/\//g, '-').replace(/^-/, '');
const MEMORY_DIR = path.join(os.homedir(), '.claude', 'projects', encodedCwd, 'memory');
const RULES_SUBDIR = path.join(MEMORY_DIR, 'synced-rules');
const MEMORY_INDEX = path.join(MEMORY_DIR, 'MEMORY.md');

function slugify(text, maxLen = 40) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen);
}

function ruleToMarkdown(rule) {
  const categories = (rule.categories || []).join(', ');
  const projects = (rule.projects || []).join(', ');
  const source = rule._source === 'team' ? 'team (rules-shared.json)' : 'personal (rules.json)';
  const frontmatter = [
    '---',
    `name: ${rule.id}`,
    `description: ${rule.text.replace(/\n/g, ' ').slice(0, 150)}`,
    'type: feedback',
    `categories: [${categories}]`,
    `projects: [${projects}]`,
    `reinforcements: ${rule.reinforcementCount || 0}`,
    `source: ${source}`,
    '---',
    '',
    rule.text,
    '',
    '**Why:** Extracted from past sessions with high reinforcement — empirically validated.',
    `**How to apply:** When prompt matches keywords in categories (${categories || 'general'}) or projects (${projects || 'any'}).`,
    '',
  ].join('\n');
  return frontmatter;
}

function loadRules(filePath, source) {
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')).map(r => ({ ...r, _source: source }));
  } catch {
    return [];
  }
}

function main() {
  if (CLEAN) {
    if (fs.existsSync(RULES_SUBDIR)) {
      const files = fs.readdirSync(RULES_SUBDIR);
      console.log(`Removing ${files.length} synced rule files from ${RULES_SUBDIR}`);
      for (const f of files) fs.unlinkSync(path.join(RULES_SUBDIR, f));
      fs.rmdirSync(RULES_SUBDIR);
    }
    // Remove synced-rules entries from MEMORY.md
    if (fs.existsSync(MEMORY_INDEX)) {
      const content = fs.readFileSync(MEMORY_INDEX, 'utf8');
      const cleaned = content
        .split('\n')
        .filter(line => !line.includes('synced-rules/'))
        .join('\n');
      fs.writeFileSync(MEMORY_INDEX, cleaned);
    }
    console.log('Cleaned.');
    return;
  }

  // Load both personal (rules.json) and team (rules-shared.json) rules.
  // Deduplicate by id — team rules take precedence.
  const team = loadRules(TEAM_RULES_PATH, 'team');
  const personal = loadRules(PERSONAL_RULES_PATH, 'personal');
  const teamIds = new Set(team.map(r => r.id));
  const uniquePersonal = personal.filter(r => !teamIds.has(r.id));
  const rules = [...team, ...uniquePersonal];

  const eligible = rules.filter(
    r => r.status === 'active' && (r.reinforcementCount || 0) >= MIN_REINFORCEMENTS
  );

  console.log(`Workspace:        ${WORKSPACE_ROOT}`);
  console.log(`Native memory:    ${MEMORY_DIR}`);
  console.log(`Total rules:      ${rules.length}`);
  console.log(`Eligible (>=${MIN_REINFORCEMENTS}): ${eligible.length}`);
  console.log(`Mode:             ${DRY_RUN ? 'DRY-RUN' : 'APPLY'}`);
  console.log('');

  if (eligible.length === 0) {
    console.log('No eligible rules.');
    return;
  }

  if (DRY_RUN) {
    console.log('Would sync:');
    eligible.slice(0, 10).forEach(r => {
      console.log(`  - [${r.reinforcementCount}x] ${r.id}: ${r.text.slice(0, 80)}`);
    });
    if (eligible.length > 10) console.log(`  ... and ${eligible.length - 10} more`);
    console.log('');
    console.log('Run with --apply to write.');
    return;
  }

  // Apply
  fs.mkdirSync(RULES_SUBDIR, { recursive: true });

  // Read existing MEMORY.md (if any)
  let indexLines = [];
  if (fs.existsSync(MEMORY_INDEX)) {
    indexLines = fs.readFileSync(MEMORY_INDEX, 'utf8').split('\n');
  }
  // Remove any pre-existing synced-rules entries to avoid duplicates
  indexLines = indexLines.filter(line => !line.includes('synced-rules/'));

  // Ensure index has a header
  if (!indexLines.some(l => l.startsWith('#'))) {
    indexLines = ['# Memory Index', ''];
  }

  // Write each rule + index entry
  for (const rule of eligible) {
    const slug = slugify(rule.text) || rule.id;
    const filename = `${slug}-${rule.id.slice(0, 6)}.md`;
    const filepath = path.join(RULES_SUBDIR, filename);
    fs.writeFileSync(filepath, ruleToMarkdown(rule));
    const preview = rule.text.slice(0, 100).replace(/\n/g, ' ');
    indexLines.push(`- [Rule ${rule.id}](synced-rules/${filename}) — ${preview}`);
  }

  // Write index
  fs.writeFileSync(MEMORY_INDEX, indexLines.filter(Boolean).join('\n') + '\n');

  console.log(`Synced ${eligible.length} rules to ${RULES_SUBDIR}`);
  console.log(`Updated index: ${MEMORY_INDEX}`);
}

main();
