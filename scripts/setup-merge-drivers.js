'use strict';

const { execFileSync } = require('node:child_process');

let root;
try {
  root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
} catch {
  process.stderr.write('setup-merge-drivers: not a git repository\n');
  process.exit(1);
}

execFileSync('git', ['config', 'merge.jsonl-union.name',
  'JSONL union merge (session events)'], { cwd: root });
execFileSync('git', ['config', 'merge.jsonl-union.driver',
  'node ./scripts/git-merge-jsonl-union.js %O %A %B'], { cwd: root });

process.stdout.write('Registered merge driver: jsonl-union\n');
process.stdout.write("  applies to paths tagged 'merge=jsonl-union' in .gitattributes\n");
