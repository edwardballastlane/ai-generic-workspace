'use strict';

/**
 * memory-migrate — pure mappers that convert Lane's EXISTING knowledge bases into
 * typed observations for the memory store (Phase 2). An empty memory server is
 * useless; seeding from what Lane already knows is what makes it valuable on day one.
 *
 * Sources migrated:
 *  - scripts/self-improvement/rules-shared.json  (team ExpeL rules) → type 'pattern'
 *  - MEMORY.md index + memory/<slug>.md bodies    (curated auto-memory) → type 'decision'
 *
 * All mappers are pure (data in → observation partials out); the CLI does I/O and
 * calls memory-store.saveObservation (idempotent by id, so re-running is safe).
 */

/** One ExpeL rule → an observation partial. id `rule:<id>` keeps migration idempotent. */
function ruleToObservation(rule) {
  if (!rule || !rule.id || !rule.text) return null;
  const text = String(rule.text);
  return {
    id: `rule:${rule.id}`,
    ts: rule.createdAt || undefined,
    type: 'pattern',
    scope: 'project',
    title: text.length > 120 ? text.slice(0, 117) + '…' : text,
    content: text,
    tags: Array.isArray(rule.categories) ? rule.categories : [],
    project: Array.isArray(rule.projects) && rule.projects.length ? String(rule.projects[0]) : '',
    source: 'rules-shared',
  };
}

/** Map an array of rules → observation partials (skips inactive/invalid). */
function rulesToObservations(rules, { activeOnly = true } = {}) {
  return (Array.isArray(rules) ? rules : [])
    .filter((r) => !activeOnly || !r.status || r.status === 'active')
    .map(ruleToObservation)
    .filter(Boolean);
}

/** Parse a MEMORY.md index into {title, file, hook} entries. Lines: `- [Title](file.md) — hook`. */
function parseMemoryIndex(text) {
  const out = [];
  const re = /^-\s*\[([^\]]+)\]\(([^)]+)\)\s*(?:[—-]\s*(.*))?$/;
  for (const raw of String(text || '').split('\n')) {
    const m = re.exec(raw.trim());
    if (m) out.push({ title: m[1].trim(), file: m[2].trim(), hook: (m[3] || '').trim() });
  }
  return out;
}

/** A memory file (slug + body) → an observation partial. id `memory:<slug>`. */
function memoryFileToObservation(entry, body) {
  const slug = String(entry.file).replace(/\.md$/, '');
  return {
    id: `memory:${slug}`,
    type: 'decision',
    scope: 'project',
    title: entry.title,
    content: String(body || entry.hook || entry.title),
    tags: [],
    project: '',
    source: 'MEMORY.md',
  };
}

module.exports = {
  ruleToObservation,
  rulesToObservations,
  parseMemoryIndex,
  memoryFileToObservation,
};
