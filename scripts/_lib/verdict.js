'use strict';

/**
 * verdict — verdict discipline.
 *
 * parseVerdict: extract a verdict from a verifier reply anchored to the FINAL
 *    verdict line, and disclose HOW it parsed — so a model that quotes the rubric
 *    or echoes an example can't silently flip a verdict.
 * normalizeVerdict: a verdict must match its own graded findings. A PASS beside
 *    a blocker is upgraded to FAIL; a FAIL with no blocker/major is floored to PASS
 *    (with notes). The raw token is always preserved.
 *
 * Lane uses a binary PASS/FAIL (no "concerns" tier), so the floor maps:
 *   PASS + blockers>0  → FAIL       (a pass can't ride an unflagged blocker)
 *   FAIL + 0 blockers + 0 majors → PASS (only-minor findings don't sink a task)
 * Pure — no I/O.
 */

/** Is `line` a verdict declaration? Returns 'PASS' | 'FAIL' | null. */
function verdictOf(line) {
  const s = String(line || '').trim().replace(/^\**|\**$/g, '').replace(/^verdict:\s*/i, '');
  if (/^pass\b/i.test(s)) return 'PASS';
  if (/^fail\b/i.test(s)) return 'FAIL';
  return null;
}

/**
 * Parse a verdict from a reply, anchored to the last verdict-bearing line.
 * @returns {{verdict:'PASS'|'FAIL'|null, parseState:'ok'|'ambiguous'|'no_verdict', matches:number}}
 */
function parseVerdict(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const found = [];
  for (const l of lines) { const v = verdictOf(l); if (v) found.push(v); }
  if (!found.length) return { verdict: null, parseState: 'no_verdict', matches: 0 };
  const verdict = found[found.length - 1];                 // anchor: the final verdict line wins
  const distinct = new Set(found);
  return { verdict, parseState: distinct.size > 1 ? 'ambiguous' : 'ok', matches: found.length };
}

/**
 * Normalize a verdict against its graded findings.
 * @param {{verdict:string, blockers?:number, majors?:number}} p
 * @returns {{verdict:'PASS'|'FAIL', raw:string, normalized:boolean, reason:string}}
 */
function normalizeVerdict(p) {
  const raw = String((p && p.verdict) || '').toUpperCase().startsWith('FAIL') ? 'FAIL' : 'PASS';
  const blockers = Math.max(0, Number(p && p.blockers) || 0);
  const majors = Math.max(0, Number(p && p.majors) || 0);
  let verdict = raw;
  let reason = 'verdict matches findings';
  if (raw === 'PASS' && blockers > 0) {
    verdict = 'FAIL';
    reason = `upgraded PASS→FAIL: ${blockers} blocker(s) present`;
  } else if (raw === 'FAIL' && blockers === 0 && majors === 0) {
    verdict = 'PASS';
    reason = 'floored FAIL→PASS: no blocker or major finding (minors ride a pass as notes)';
  }
  return { verdict, raw, normalized: verdict !== raw, reason };
}

module.exports = { verdictOf, parseVerdict, normalizeVerdict };
