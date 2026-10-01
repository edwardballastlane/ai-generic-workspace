'use strict';

/**
 * Gate-theater detector.
 *
 * A verification gate is only worth its cost while it still fails things.
 * When a gate approves at a rate so high (or never fails at all) it has
 * likely degraded into rubber-stamping — "theater" — and the PASS it emits
 * no longer carries information. This module flags that condition over the
 * /swarm-implement consensus panel's recorded verdicts.
 *
 * Design notes:
 *  - Pure functions only. All state (the verdict list, the window/threshold
 *    knobs) is passed in — nothing here reads disk, the clock, or the network.
 *    That injectable-everything discipline is what lets this be unit-tested with
 *    fixtures and no I/O.
 *  - Keying purely on approval *rate* would itself be gameable (decline 1-in-10 to
 *    stay under the bar), so we additionally surface `never-fails` explicitly and
 *    expose per-group analysis — a single always-PASS verifier/project can't hide
 *    inside a healthy aggregate.
 */

const DEFAULTS = Object.freeze({
  minDecisions: 8,      // below this there is not enough signal to judge
  rateThreshold: 0.95,  // PASS-rate at/above this over the window ⇒ theater
  windowSize: 30,       // only weigh the most recent N decisions (0/null = all)
});

/**
 * Normalize a verdict record (or bare string) to a PASS boolean.
 * Accepts { verdict: 'PASS' } | 'PASS' | 'ACCEPT'/'ACCEPTED' (case-insensitive).
 */
function isPass(v) {
  const raw = v && typeof v === 'object' ? v.verdict : v;
  const s = String(raw == null ? '' : raw).toUpperCase();
  return s === 'PASS' || s === 'ACCEPT' || s === 'ACCEPTED';
}

/** Most-recent-N slice, preserving oldest→newest order. */
function recentWindow(verdicts, windowSize) {
  if (!Array.isArray(verdicts)) return [];
  if (!windowSize || windowSize <= 0) return verdicts.slice();
  return verdicts.slice(-windowSize);
}

/**
 * Evaluate a flat list of verdicts for gate theater.
 *
 * @param {Array<{verdict:string}|string>} verdicts - oldest→newest
 * @param {object} [opts]
 * @param {number} [opts.minDecisions]
 * @param {number} [opts.rateThreshold]
 * @param {number} [opts.windowSize]
 * @returns {{theater:boolean, reason:string, decisions:number, passes:number,
 *            fails:number, passRate:number, threshold:number, minDecisions:number}}
 */
function detectTheater(verdicts, opts = {}) {
  const { minDecisions, rateThreshold, windowSize } = { ...DEFAULTS, ...opts };
  const window = recentWindow(verdicts, windowSize);
  const decisions = window.length;
  const passes = window.filter(isPass).length;
  const fails = decisions - passes;
  const passRate = decisions ? passes / decisions : 0;

  const base = { decisions, passes, fails, passRate, threshold: rateThreshold, minDecisions };

  if (decisions < minDecisions) {
    return { theater: false, reason: 'insufficient-data', ...base };
  }

  const theater = passRate >= rateThreshold;
  if (!theater) return { theater, reason: 'healthy', ...base };
  // A gate that has literally never failed is a stronger signal than one that
  // merely passes often, so the two get distinct reasons.
  const reason = fails === 0 ? 'never-fails' : 'pass-rate-above-threshold';

  return { theater, reason, ...base };
}

/**
 * Bucket verdicts by a key (e.g. project, panel type, or verifier id) and
 * run detectTheater on each bucket independently, so an always-PASS slice
 * can't be averaged away by healthy ones.
 *
 * @param {Array} verdicts
 * @param {(v:object)=>string} keyFn
 * @param {object} [opts] - same knobs as detectTheater
 * @returns {Record<string, ReturnType<typeof detectTheater>>}
 */
function detectByGroup(verdicts, keyFn, opts = {}) {
  const groups = new Map();
  for (const v of Array.isArray(verdicts) ? verdicts : []) {
    const k = (v && keyFn(v)) || 'unknown';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(v);
  }
  const out = {};
  for (const [k, vs] of groups) out[k] = detectTheater(vs, opts);
  return out;
}

module.exports = { DEFAULTS, isPass, recentWindow, detectTheater, detectByGroup };
