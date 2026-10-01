'use strict';

/**
 * memory-consolidate — the write-time consolidation gate (Mem0's
 * ADD/UPDATE/NOOP/SUPERSEDE contract, adapted conservatively for a git-shared,
 * human-readable JSONL store).
 *
 * Design choice: we do NOT auto-merge content (that's destructive and risky in a
 * team store). Instead the store is append-only + bi-temporal, so an
 * "update" is modelled as a SUPERSEDE: the new record becomes current and the old
 * one is closed (valid_to set, superseded_by pointed at the new id, history kept).
 *
 * The gate is intentionally deterministic (normalized-text comparison, no LLM, no
 * embeddings on the hot path) so it never silently corrupts memory:
 *   - NOOP      — an existing, still-valid, same-type record has identical
 *                 normalized (title + content). The new write is redundant → drop it.
 *   - SUPERSEDE — an existing, still-valid, same-type record has the SAME normalized
 *                 title but DIFFERENT content → the same observation re-recorded with
 *                 evolved detail. Close the old, write the new as revision+1.
 *   - ADD       — anything else (distinct title = distinct finding) → append fresh.
 *
 * Pure + dependency-free → unit-testable; memory-store wires it into saveObservation.
 */

/** Lowercase, strip punctuation, collapse whitespace — for stable equality checks. */
function normText(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** A record is a live consolidation target if it's the same type and not superseded. */
function isLiveTarget(candidate, e) {
  return e && e.id !== candidate.id && e.type === candidate.type && !e.valid_to;
}

/**
 * Decide how a candidate observation should be written against the existing set.
 *
 * @param {object}   candidate       normalized-ish observation about to be written
 * @param {object[]} existing        all observations already in scope
 * @returns {{action: 'add'|'noop'|'supersede', targetId?: string, revision?: number}}
 */
function decideWrite(candidate, existing = []) {
  if (!candidate || !candidate.title) return { action: 'add' };
  const candTitle = normText(candidate.title);
  const candFull = `${candTitle} ${normText(candidate.content)}`.trim();

  // Newest-first so a SUPERSEDE closes the most recent prior version.
  const live = (Array.isArray(existing) ? existing : [])
    .filter((e) => isLiveTarget(candidate, e))
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));

  for (const e of live) {
    if (`${normText(e.title)} ${normText(e.content)}`.trim() === candFull) {
      return { action: 'noop', targetId: e.id };
    }
  }
  if (candTitle) {
    for (const e of live) {
      if (normText(e.title) === candTitle) {
        return { action: 'supersede', targetId: e.id, revision: (Number(e.revision) || 0) + 1 };
      }
    }
  }
  return { action: 'add' };
}

module.exports = { decideWrite, normText };
