'use strict';

/**
 * memory-tiers — tiered, decaying memory: leave the next session a compact current operating
 * map rather than an accumulating journal. Observations are classified into tiers that decide
 * what a decay pass does with them:
 *
 *   pinned     — no clock is ever read; never decays (authority/design that doesn't age).
 *   aging      — must re-prove itself: stale at >= 30 days since last-reinforced → archive.
 *   perishable — stored expecting disposal: stale at >= 7 days (short-lived, e.g. summaries).
 *
 * Stale entries RETIRE to a cold archive (via valid_to + a cold copy), never deleted — so the
 * live store shrinks to what's current while history is recoverable. Complements the
 * consolidation/supersession (a different axis: age-based retirement, not dedup/contradiction).
 *
 * Pure → unit-testable; scripts/memory-stow.js runs the pass.
 */

const DAY_MS = 86400000;
const THRESHOLD_DAYS = { aging: 30, perishable: 7 };

// Default tier by observation type. IMPORTANT: Lane has NO reinforcement signal on
// observations — nothing re-proves or date-refreshes an entry when it gets used — so an aging
// default would archive valuable-but-old curated knowledge (RCAs, discoveries) on the first
// pass. Therefore CURATED types default to `pinned` (durable), only
// `session_summary` is `perishable` (a genuinely disposable journal), and `aging` is OPT-IN
// (an obs must set tier:'aging' explicitly). Revisit once observations gain a reinforcement clock.
const PERISHABLE_TYPES = ['session_summary'];

function defaultTier(type) {
  if (PERISHABLE_TYPES.includes(type)) return 'perishable';
  return 'pinned';
}

function tierOf(obs) {
  const t = obs && obs.tier;
  if (t === 'pinned' || t === 'aging' || t === 'perishable') return t;
  return defaultTier(obs && obs.type);
}

/** The date a decay clock measures from: explicit last-reinforced, else valid_from, else ts. */
function lastReinforcedOf(obs) {
  return (obs && (obs.lastReinforced || obs.valid_from || obs.ts)) || null;
}

/**
 * Classify an observation for the decay pass.
 * @param {object} obs
 * @param {number} now  ms epoch (injected for tests)
 * @returns {{tier: string, stale: boolean, ageDays: (number|null)}}
 */
function classify(obs, now) {
  const tier = tierOf(obs);
  if (tier === 'pinned') return { tier, stale: false, ageDays: null };
  const t = Date.parse(lastReinforcedOf(obs));
  if (!Number.isFinite(t)) return { tier, stale: false, ageDays: null }; // no clock → never archive blindly
  const ageDays = Math.max(0, (now - t) / DAY_MS);
  const threshold = THRESHOLD_DAYS[tier] || THRESHOLD_DAYS.aging;
  return { tier, stale: ageDays >= threshold, ageDays };
}

module.exports = {
  DAY_MS, THRESHOLD_DAYS, PERISHABLE_TYPES,
  defaultTier, tierOf, lastReinforcedOf, classify,
};
