#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function findTests(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) findTests(p, out);
    else if (entry.isFile() && entry.name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

const tests = findTests('tests');
if (tests.length === 0) {
  console.error('run-tests: no .test.js files found under tests/');
  process.exit(1);
}

const passthrough = process.argv.slice(2);
const r = spawnSync(process.execPath,
  ['--test', '--test-reporter=spec', ...passthrough, ...tests],
  { stdio: 'inherit' });

process.exit(r.status ?? 1);
