'use strict';

/**
 * Refusal ratchet — pure logic.
 *
 * Lane is a hook layer whose UX to the agent is largely refusal messages
 * ("BLOCKED: ...", thrown errors). A refusal that just says "no" is a dead end;
 * a good refusal names a runnable next step. This ratchet enforces the
 * invariant: every refusal must EITHER
 *   (a) name an actionable continuation (a command, `/skill`, env var, "instead"…), OR
 *   (b) carry a `// refusal:by-design <reason>` marker from a closed vocabulary
 *       (for refusals that legitimately have no next step — e.g. force-push to master), OR
 *   (c) already be frozen in the baseline (legacy — grandfathered, not blocked).
 * New dead-end refusals fail CI.
 *
 * Pure: callers extract refusal records {file, message, byDesignReason} and pass
 * them in with the parsed baseline Set. No I/O here (keeps it unit-testable).
 */

const { diff } = require('./ratchet');

/** Closed vocabulary for `// refusal:by-design <reason>`. */
const BY_DESIGN_VOCAB = new Set([
  'human-authority',    // only a human may authorize this (force-push, prod deploy)
  'world-action',       // depends on external world state the tool can't change
  'operator-knowledge', // needs info only the operator has
  'environment',        // environment/config precondition unmet
]);

/** Signals that a refusal message names an actionable continuation. */
const CONTINUATION_SIGNALS = [
  /`[^`]+`/,                                  // a backtick-quoted command or path
  /\buse\s+\//i,                              // "Use /pre-push"
  // "run" / "instead" must POINT somewhere. Bare-word matches let a dead end
  // ("this cannot be run here") pass as actionable, which is exactly the
  // failure the ratchet exists to catch.
  /\brun\s+(?:npm|node|git|yarn|pnpm|make|\.\/|\/)/i,
  /\bnpm run\b/i,
  /\bnode\s+scripts\//i,
  /\.\/scripts\//,
  /\b(?:use|try|do|reference|set|pass|call|prefer|store)\b[^\n]{0,120}?\binstead\b/i,  // "reference an env var instead"
  /\bto\s+(inspect|use|enable|re-enable|fix|see|resolve|retry|continue)\b/i,
  /→|->/,                                     // "→ next step"
  /\bexport\s+[A-Z]/,                         // "export LANE_BLOCK_ENV_READS=1"
];

/** Classify one refusal record. */
function classifyRefusal(r) {
  const msg = String((r && r.message) || '');
  const reason = r && r.byDesignReason;
  const byDesign = reason ? BY_DESIGN_VOCAB.has(reason) : false;
  const actionable = CONTINUATION_SIGNALS.some((re) => re.test(msg));
  return {
    actionable,
    byDesign,
    deadEnd: !actionable && !byDesign,
    // A marker with a reason outside the vocabulary is itself a violation
    // (prevents smuggling arbitrary excuses past the ratchet).
    invalidByDesign: !!reason && !byDesign,
  };
}

/** Stable content key: (file, message). Editing a refusal's text re-opens the question. */
function keyOf(r) {
  return `${r.file}\t${r.message}`;
}

/**
 * Evaluate all refusals against the baseline.
 * @param {Array<{file,message,byDesignReason?}>} refusals
 * @param {Set<string>} baselineSet - parsed baseline (keys)
 * @returns {{classified, added, removed, violations, currentKeys}}
 */
function evaluate(refusals, baselineSet) {
  const classified = (refusals || []).map((r) => ({ ...r, ...classifyRefusal(r), key: keyOf(r) }));
  const currentKeys = new Set(classified.map((r) => r.key));
  const { added, removed } = diff(currentKeys, baselineSet);
  const addedSet = new Set(added);
  const violations = classified.filter((r) =>
    (addedSet.has(r.key) && r.deadEnd) || r.invalidByDesign);
  return { classified, added, removed, violations, currentKeys };
}

/** Keys that must be frozen when (re)generating the baseline: current dead-ends. */
function baselineKeysFor(refusals) {
  return (refusals || [])
    .map((r) => ({ ...r, ...classifyRefusal(r), key: keyOf(r) }))
    .filter((r) => r.deadEnd)
    .map((r) => r.key);
}

module.exports = {
  BY_DESIGN_VOCAB,
  CONTINUATION_SIGNALS,
  classifyRefusal,
  keyOf,
  evaluate,
  baselineKeysFor,
};
