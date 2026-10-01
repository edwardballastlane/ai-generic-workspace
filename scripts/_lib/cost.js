'use strict';

/**
 * Model pricing table: per-million-token prices for input, output,
 * cache write (5m TTL = `pcw5m`, 1h TTL = `pcw1h`), and cache read.
 *
 * The 1h cache write price is 1.6x the 5m price across all current Anthropic
 * tiers; in observed workloads the 1h variant dominates cache creates, so this
 * distinction materially affects estimates.
 *
 * Order of regexes matters — more-specific patterns must precede bare suffixes.
 *
 * @param {string} model
 * @returns {{ pi: number, po: number, pcw5m: number, pcw1h: number, pcr: number }}
 */
function priceFor(model) {
  // Fable 5 / Mythos 5: $10/$50 tier — above Opus. Same 1M context. Must be
  // matched BEFORE the generic fall-through below, or a fable session silently
  // prices at the Sonnet default. Cache rates follow the uniform Anthropic
  // convention used across every tier here (5m write 1.25×, 1h write 2×, read
  // 0.1× of input).
  if (/fable|mythos/.test(model))   return { pi: 10,   po: 50,   pcw5m: 12.50, pcw1h: 20,   pcr: 1.00 };
  // Opus 5.x: $5/$25 tier (same rates as Opus >= 4.5). Without this, the id
  // 'claude-opus-5' matches none of the opus-4/opus-3 patterns and silently
  // prices at the Sonnet default.
  if (/opus-5/.test(model))         return { pi: 5,    po: 25,   pcw5m: 6.25,  pcw1h: 10,   pcr: 0.50 };
  // Opus 4.x: minor >= 5 is the current $5/$25 tier (4.5/4.6/4.7/4.8/...),
  // minor 0-4 (4.0/4.1) is the legacy $15/$75 tier. Matching the minor version
  // numerically keeps new releases (4.8, 4.9, ...) on the right tier instead of
  // silently falling through to the Sonnet default below.
  const opusMinor = model.match(/opus-4-(\d+)/);
  if (opusMinor) {
    return Number(opusMinor[1]) >= 5
      ? { pi: 5,  po: 25, pcw5m: 6.25,  pcw1h: 10, pcr: 0.50 }
      : { pi: 15, po: 75, pcw5m: 18.75, pcw1h: 30, pcr: 1.50 };
  }
  if (/opus-4$/.test(model))        return { pi: 15,   po: 75,   pcw5m: 18.75, pcw1h: 30,   pcr: 1.50 };
  if (/opus-3/.test(model))         return { pi: 15,   po: 75,   pcw5m: 18.75, pcw1h: 30,   pcr: 1.50 };
  if (/sonnet-4/.test(model))       return { pi: 3,    po: 15,   pcw5m: 3.75,  pcw1h: 6,    pcr: 0.30 };
  if (/sonnet-3-(5|7)/.test(model)) return { pi: 3,    po: 15,   pcw5m: 3.75,  pcw1h: 6,    pcr: 0.30 };
  if (/haiku-4/.test(model))        return { pi: 1,    po: 5,    pcw5m: 1.25,  pcw1h: 2,    pcr: 0.10 };
  if (/haiku-3-5/.test(model))      return { pi: 0.80, po: 4,    pcw5m: 1.00,  pcw1h: 1.60, pcr: 0.08 };
  if (/haiku-3/.test(model))        return { pi: 0.25, po: 1.25, pcw5m: 0.30,  pcw1h: 0.48, pcr: 0.03 };
  return { pi: 3, po: 15, pcw5m: 3.75, pcw1h: 6, pcr: 0.30 };
}

/**
 * Compute cost in USD for a set of token counts against a given model.
 *
 * Token shape compatibility:
 * - When `cacheCreation5m` and/or `cacheCreation1h` are present, they're priced
 *   separately at the correct TTL rates.
 * - Otherwise `cacheCreation` (legacy aggregate) is priced at the 5m rate to
 *   preserve backward compatibility with rows recorded before the breakdown
 *   was tracked.
 *
 * @param {string} model - Model identifier (e.g. 'claude-opus-4-7').
 * @param {{ input: number, output: number, cacheCreation?: number, cacheCreation5m?: number, cacheCreation1h?: number, cacheRead: number }} tokens
 * @returns {number} Cost in USD.
 */
function computeCostUsd(model, tokens) {
  const { pi, po, pcw5m, pcw1h, pcr } = priceFor(model || '');
  const t5 = Number(tokens.cacheCreation5m || 0);
  const t1 = Number(tokens.cacheCreation1h || 0);
  const cacheCreateCost = (t5 > 0 || t1 > 0)
    ? t5 * pcw5m + t1 * pcw1h
    : Number(tokens.cacheCreation || 0) * pcw5m;
  const total =
    tokens.input * pi +
    tokens.output * po +
    cacheCreateCost +
    tokens.cacheRead * pcr;
  return total / 1_000_000;
}

module.exports = { computeCostUsd, priceFor };
