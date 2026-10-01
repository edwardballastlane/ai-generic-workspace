'use strict';

/**
 * Shared core for the monotonic "ratchet" checks: deadcode, refusal and guard.
 *
 * A ratchet freezes a baseline of some quality-negative population and forbids
 * GROWTH: entries present now but not in the baseline are violations; entries in
 * the baseline but no longer present are fine (and worth removing from the
 * baseline to tighten the guard). This lets a repo that already carries N
 * legitimate cases adopt the guard immediately — you freeze N and refuse N+1 —
 * instead of blocking until the count reaches zero.
 *
 * Pure: no I/O. CLIs own reading/writing the baseline file and call diff().
 * Baselines are keyed on content (not line/col) so unrelated edits don't churn.
 */

/** Parse a baseline file's text into a Set of entry lines (drops blanks + # comments). */
function parseBaseline(text) {
  const set = new Set();
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '' || line.startsWith('#')) continue;
    set.add(line);
  }
  return set;
}

/**
 * Serialize entries to baseline-file text: deduped, blank-stripped, and sorted
 * in codepoint order so the file is deterministic across machines (mirrors
 * a pinned `LC_ALL=C` sort).
 */
function serializeBaseline(entries) {
  const uniq = [...new Set(entries)].filter((e) => typeof e === 'string' && e.trim() !== '');
  uniq.sort();
  return uniq.length ? uniq.join('\n') + '\n' : '';
}

/**
 * Compare the current population against the baseline.
 * @returns {{added: string[], removed: string[]}} added = grew past baseline
 *          (violations for a forbid-growth ratchet); removed = shrank (safe).
 */
function diff(current, baseline) {
  const cur = current instanceof Set ? current : new Set(current);
  const base = baseline instanceof Set ? baseline : new Set(baseline);
  const added = [...cur].filter((e) => !base.has(e)).sort();
  const removed = [...base].filter((e) => !cur.has(e)).sort();
  return { added, removed };
}

module.exports = { parseBaseline, serializeBaseline, diff };
