'use strict';

/**
 * Guard-population registry — pure logic.
 *
 * A tamper-evident registry of the security guards in Lane's hooks: each
 * safety-critical guard carries a
 *   `// guard:population <family> <too-tight|too-loose|fail-closed>: <why>`
 * marker. This module fingerprints (sha256) the guarded code region so any NEW
 * guard, DROPPED guard, or REFACTOR that alters guard logic changes the registry
 * and fails CI until re-approved (regenerate the baseline).
 *
 * Fingerprint region = the lines from the marker to (and including) the first
 * `block(` call (the enforcement point), whitespace-normalized. Pure: caller
 * passes file text; no I/O.
 */

const crypto = require('node:crypto');

const MARKER_RE = /\/\/\s*guard:population\s+(\S+)\s+(too-tight|too-loose|fail-closed)\s*:?\s*(.*)/;
const MAX_REGION_LINES = 20;

// 128 bits. The registry is the tamper-evident record of what each security
// guard checks, so the fingerprint has to survive someone *trying* to land a
// colliding rewrite, not just catch an accidental edit.
const FINGERPRINT_HEX = 32;

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, FINGERPRINT_HEX);
}

/** Extract guard records {file, family, direction, reason, sha} from one file's text. */
function extractGuards(fileText, relFile) {
  const lines = String(fileText || '').split('\n');
  const out = [];
  for (let n = 0; n < lines.length; n++) {
    const m = MARKER_RE.exec(lines[n]);
    if (!m) continue;
    const [family, direction, reason] = [m[1], m[2], (m[3] || '').trim()];
    // Capture from the line after the marker up to and including the first block(...).
    const region = [];
    for (let k = n + 1; k < lines.length && region.length < MAX_REGION_LINES; k++) {
      region.push(lines[k]);
      if (lines[k].includes('block(')) break;
    }
    const normalized = region.map((l) => l.trim()).filter(Boolean).join('\n');
    out.push({ file: relFile, family, direction, reason, sha: sha256(normalized) });
  }
  return out;
}

/** Stable registry key pinning file+family+direction+logic-fingerprint. */
function keyOf(g) {
  return `${g.file}\t${g.family}\t${g.direction}\t${g.sha}`;
}

module.exports = { MARKER_RE, sha256, extractGuards, keyOf };
