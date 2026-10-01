'use strict';

/**
 * retired-terms — pure logic for the retired-term absence ratchet: a clean-break
 * guard. Once a concept is deprecated, this keeps it from creeping back into
 * ACTIVE code/config via copy-paste or a resurrected
 * doc. Scans active source only (not the registry, tests, docs, specs, or logs — which
 * legitimately reference a retirement to explain or assert it). Pure — caller supplies
 * the {file, text} sources and the term list.
 */

/** Parse a `.retired-terms.txt` registry (drops blanks + # comments). */
function parseTerms(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.replace(/\r$/, '').trim())
    .filter((l) => l && !l.startsWith('#'));
}

/**
 * Find retired terms that reappear in the given active sources.
 * @param {Array<{file:string,text:string}>} sources
 * @param {string[]} terms
 * @returns {Array<{file:string, term:string, line:number}>}
 */
function findRetired(sources, terms) {
  const hits = [];
  for (const s of sources || []) {
    const lines = String(s.text || '').split('\n');
    for (const term of terms || []) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(term)) hits.push({ file: s.file, term, line: i + 1 });
      }
    }
  }
  return hits;
}

module.exports = { parseTerms, findRetired };
