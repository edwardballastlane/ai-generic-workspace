#!/usr/bin/env node
'use strict';

/**
 * refusal-ratchet — CI guard that forbids NEW dead-end refusals in Lane's hooks.
 *
 * Extracts refusal messages from scripts/hooks/*.js (the agent-facing refusal
 * surface: `block('...')` and `throw new Error('...')`), then requires each to
 * name a next step, carry a `// refusal:by-design <reason>` marker, or be frozen
 * in .refusal-ratchet-baseline.txt. Detector logic lives in
 * scripts/_lib/refusal-ratchet.js (pure + unit-tested).
 *
 * Usage:
 *   node scripts/refusal-ratchet.js            # check; exit 1 on new dead-ends
 *   node scripts/refusal-ratchet.js --update   # freeze current dead-ends as baseline
 *   node scripts/refusal-ratchet.js --json
 *
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseBaseline, serializeBaseline } = require('./_lib/ratchet');
const { evaluate, baselineKeysFor } = require('./_lib/refusal-ratchet');

const SINKS = ['block(', 'throw new Error('];
const BY_DESIGN_RE = /\/\/\s*refusal:by-design\s+([a-z-]+)/i;

function findWorkspaceRoot() {
  if (process.env.WORKSPACE_ROOT) return process.env.WORKSPACE_ROOT;
  let cur = __dirname;
  for (let i = 0; i < 15; i++) {
    if (fs.existsSync(path.join(cur, 'CLAUDE.md'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return process.cwd();
}

/** Extract the first quoted string literal starting at/after `from`. Handles ' " ` and \ escapes. */
function extractStringAt(line, from) {
  let i = from;
  while (i < line.length && line[i] === ' ') i++;
  const q = line[i];
  if (q !== '"' && q !== "'" && q !== '`') return null;
  let out = '';
  i++;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '\\') { out += line[i + 1] || ''; i += 2; continue; }
    if (ch === q) return out;
    out += ch;
    i++;
  }
  return out; // unterminated on this line — return what we have
}

/** Extract refusal records from one file's text. */
function extractRefusals(relFile, text) {
  const lines = text.split('\n');
  const out = [];
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    for (const sink of SINKS) {
      let idx = line.indexOf(sink);
      while (idx !== -1) {
        const msg = extractStringAt(line, idx + sink.length);
        if (msg != null && msg.trim() !== '') {
          const here = BY_DESIGN_RE.exec(line);
          const above = n > 0 ? BY_DESIGN_RE.exec(lines[n - 1]) : null;
          const marker = here || above;
          out.push({
            file: relFile,
            message: msg,
            byDesignReason: marker ? marker[1].toLowerCase() : undefined,
          });
        }
        idx = line.indexOf(sink, idx + sink.length);
      }
    }
  }
  return out;
}

function listHookFiles(root) {
  const dir = path.join(root, 'scripts', 'hooks');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join('scripts', 'hooks', f));
}

function main() {
  const root = findWorkspaceRoot();
  const asJson = process.argv.includes('--json');
  const update = process.argv.includes('--update');
  const baselinePath = path.join(root, '.refusal-ratchet-baseline.txt');

  const refusals = [];
  for (const rel of listHookFiles(root)) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    refusals.push(...extractRefusals(rel, text));
  }

  if (update) {
    const keys = baselineKeysFor(refusals);
    const header = [
      '# refusal-ratchet baseline — frozen legacy dead-end refusals (forbid-growth ratchet).',
      '# Each line is `<file>\\t<message>`. A NEW dead-end refusal not listed here fails CI.',
      '# Prefer fixing the refusal (name a next step) or marking it',
      '# `// refusal:by-design <human-authority|world-action|operator-knowledge|environment>`',
      '# over adding it here. Regenerate with: npm run ratchet:refusal -- --update',
      '',
    ].join('\n');
    fs.writeFileSync(baselinePath, header + serializeBaseline(keys));
    console.log(`refusal-ratchet: baseline written with ${new Set(keys).size} frozen dead-end refusal(s) → ${path.relative(root, baselinePath)}`);
    return;
  }

  const baselineSet = fs.existsSync(baselinePath)
    ? parseBaseline(fs.readFileSync(baselinePath, 'utf8'))
    : new Set();
  const res = evaluate(refusals, baselineSet);

  if (asJson) {
    process.stdout.write(JSON.stringify({
      total: refusals.length,
      actionable: res.classified.filter((r) => r.actionable).length,
      byDesign: res.classified.filter((r) => r.byDesign).length,
      baselineFrozen: baselineSet.size,
      violations: res.violations,
      removedFromBaseline: res.removed,
    }, null, 2) + '\n');
  } else {
    console.log('Refusal ratchet — hook refusal messages must name a next step');
    console.log('─'.repeat(64));
    console.log(`scanned: ${refusals.length} refusals across scripts/hooks/*.js`);
    console.log(`  actionable: ${res.classified.filter((r) => r.actionable).length}  by-design: ${res.classified.filter((r) => r.byDesign).length}  frozen(baseline): ${baselineSet.size}`);
    if (res.removed.length) {
      console.log(`\n${res.removed.length} baseline entr(y/ies) no longer present — tighten with \`npm run ratchet:refusal -- --update\`:`);
      for (const k of res.removed) console.log(`  - ${k.replace('\t', '  ::  ')}`);
    }
    if (res.violations.length) {
      console.log(`\n✗ ${res.violations.length} NEW dead-end refusal(s):`);
      for (const v of res.violations) {
        const why = v.invalidByDesign ? `unknown by-design reason "${v.byDesignReason}"` : 'no next step named';
        console.log(`  ${v.file}\n    "${v.message}"\n    → ${why}. Add a runnable next step to the message, or a \`// refusal:by-design <human-authority|world-action|operator-knowledge|environment>\` marker.`);
      }
    } else {
      console.log('\n✓ no new dead-end refusals');
    }
  }

  process.exit(res.violations.length ? 1 : 0);
}

if (require.main === module) main();

module.exports = { extractStringAt, extractRefusals, findWorkspaceRoot, listHookFiles };
