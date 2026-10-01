'use strict';

/**
 * Agent model router — tiered cost routing for spawned agents/teammates.
 *
 * We run Opus by default, but a lot of orchestrated work is mechanical (one-line
 * edits, renames, fixtures) or read-only (review, planning) and lands fine on a
 * cheaper tier. This advisory heuristic picks haiku / sonnet / opus from the
 * signals available at spawn time (agent type, the plan's complexity flag, the
 * task description, and how many files it owns), so callers like
 * /swarm-implement can route per-task instead of paying Opus everywhere.
 *
 * Advisory, not enforced: the orchestrator applies the result when spawning a
 * teammate (same pattern as /brainstorm pinning its tasks to haiku).
 *
 * Programmatic:
 *   const { selectModel } = require('./agent-router');
 *   selectModel({ agentType: 'implementer', complexity: 'low', description: 'fix typo', fileCount: 1 });
 *
 * CLI (so command markdown can shell out deterministically):
 *   node scripts/agent-router.js --agent implementer --complexity low --files 1 --desc "fix typo"
 *   → prints: haiku
 */

const VALID_MODELS = ['haiku', 'sonnet', 'opus'];

// Agent types whose work is read-only or bounded enough that Sonnet suffices.
const SONNET_AGENTS = new Set([
  'spec-writer',
  'breakdown-planner',
  'reliability-hunter',
  'tester',
  'documenter',
  'reviewer',
  'verifier',
]);

// Trivial / mechanical work → cheapest tier.
const TRIVIAL_RE = /\b(typo|rename|one[- ]?line|trivial|bump|format|formatting|lint|comment|whitespace|import order)\b/i;

// Work where a mistake is expensive → keep on the top tier regardless of size.
const SENSITIVE_RE = /\b(security|auth|authentication|authorization|crypto|encrypt|password|secret|token|migration|schema change|payment|billing|architecture|concurrency|race condition)\b/i;

/**
 * @param {object} opts
 * @param {string} [opts.agentType]    e.g. 'implementer', 'tester', 'reviewer'
 * @param {string} [opts.complexity]   'low' | 'medium' | 'high' (from the breakdown plan)
 * @param {string} [opts.description]  task description / title
 * @param {number} [opts.fileCount]    number of files the task owns
 * @returns {'haiku'|'sonnet'|'opus'}
 */
function selectModel(opts = {}) {
  const agentType = String(opts.agentType || '').toLowerCase().trim();
  const complexity = String(opts.complexity || '').toLowerCase().trim();
  const description = String(opts.description || '');
  const fileCount = Number.isFinite(opts.fileCount) ? Number(opts.fileCount) : 0;

  const fallback = normalizeModel(process.env.AGENT_ROUTER_DEFAULT) || 'sonnet';

  // 1. Sensitive work overrides everything → top tier.
  if (SENSITIVE_RE.test(description)) return 'opus';

  // 2. High complexity or broad blast radius → top tier.
  if (complexity === 'high' || fileCount > 3) return 'opus';

  // 3. Explicitly trivial / mechanical → cheapest tier.
  if (complexity === 'low' || TRIVIAL_RE.test(description)) return 'haiku';

  // 4. Read-only / bounded agent roles → mid tier.
  if (SONNET_AGENTS.has(agentType)) return 'sonnet';

  // 5. Everything else (medium implementer work) → configurable default.
  return fallback;
}

function normalizeModel(value) {
  if (!value) return null;
  const v = String(value).toLowerCase().trim();
  return VALID_MODELS.includes(v) ? v : null;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--agent') out.agentType = argv[++i];
    else if (arg === '--complexity') out.complexity = argv[++i];
    else if (arg === '--files') out.fileCount = parseInt(argv[++i], 10);
    else if (arg === '--desc') out.description = argv[++i];
  }
  return out;
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  process.stdout.write(selectModel(opts) + '\n');
}

module.exports = { selectModel, SONNET_AGENTS, VALID_MODELS };
