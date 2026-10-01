'use strict';

const fs = require('node:fs');
const path = require('node:path');

function loadDotEnv(dir) {
  const file = path.join(dir, '.env');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return 0; }
  let loaded = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, k, rawVal] = m;
    let val = rawVal;
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[k] === undefined) {
      process.env[k] = val;
      loaded++;
    }
  }
  return loaded;
}

module.exports = { loadDotEnv };
