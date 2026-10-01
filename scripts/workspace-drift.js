#!/usr/bin/env node
'use strict';

// workspace-drift.js — report what this generic workspace is missing relative
// to the upstream project workspace configured in .ai-config/upstream.json.
//
// Usage:
//   node scripts/workspace-drift.js                 Portable gaps, grouped by area
//   node scripts/workspace-drift.js --all           Include project-specific + local-only
//   node scripts/workspace-drift.js --area scripts  Filter to one area prefix
//   node scripts/workspace-drift.js --json          Machine-readable output
//   node scripts/workspace-drift.js --summary       Area counts only
//   node scripts/workspace-drift.js --upstream PATH Override the configured upstream
//   node scripts/workspace-drift.js --scan PATH...  Post-port gate: fail if local
//                                                   files still mention project terms

const fs = require('node:fs');
const path = require('node:path');
const { computeDrift, listTracked, matchTerms, toRegexes } = require('./_lib/upstream-drift');

const WORKSPACE_ROOT = path.resolve(path.dirname(fs.realpathSync(__filename)), '..');
const CONFIG_FILE = path.join(WORKSPACE_ROOT, '.ai-config', 'upstream.json');
// Committed template. The local config is gitignored (it holds a machine-specific
// upstream path), so without this fallback `--scan` could only ever run on the machine
// that authored the term list — and a gate nobody else can run is not a gate.
const TEMPLATE_FILE = path.join(WORKSPACE_ROOT, '.ai-config', 'upstream.example.json');

const ESC = String.fromCharCode(27);
const COLORS = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  orange: `${ESC}[38;5;208m`,
};

function color(name, text) {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return text;
  return `${COLORS[name]}${text}${COLORS.reset}`;
}

function parseArgs(argv) {
  const opts = { all: false, json: false, summary: false, area: null, upstream: null, scan: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') opts.all = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--summary') opts.summary = true;
    else if (arg === '--area') { i += 1; opts.area = argv[i]; }
    else if (arg === '--upstream') { i += 1; opts.upstream = argv[i]; }
    else if (arg === '--scan') opts.scan = argv.slice(i + 1).filter((a) => !a.startsWith('--'));
  }
  return opts;
}

function loadConfig() {
  for (const file of [CONFIG_FILE, TEMPLATE_FILE]) {
    if (!fs.existsSync(file)) continue;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.error(`workspace-drift: ${path.relative(WORKSPACE_ROOT, file)} is not valid JSON — ${err.message}`);
      process.exit(1);
    }
  }
  console.error(`workspace-drift: no ${path.relative(WORKSPACE_ROOT, CONFIG_FILE)} and no committed template`);
  console.error('Copy .ai-config/upstream.example.json to .ai-config/upstream.json and set upstream.path.');
  process.exit(1);
}

function resolveUpstream(config, override) {
  const root = override || config.upstream?.path;
  if (!root) {
    console.error('workspace-drift: no upstream.path configured and no --upstream given');
    process.exit(1);
  }
  if (!fs.existsSync(root)) {
    console.error(`workspace-drift: upstream not found at ${root}`);
    process.exit(1);
  }
  return root;
}

function termLabel(terms) {
  if (terms.length === 0) return '';
  const top = terms.slice(0, 3).map((t) => `${t.term} x${t.count}`).join(', ');
  return color('dim', `  [${top}]`);
}

function printFileList(title, files) {
  if (files.length === 0) return;
  console.log(`\n${color('bold', title)} ${color('dim', `(${files.length})`)}`);
  for (const f of files) {
    const size = f.status === 'drifted'
      ? `+${f.addedLines} lines vs local`
      : `${f.lines} lines`;
    console.log(`  ${f.path}  ${color('dim', size)}${termLabel(f.terms)}`);
  }
}

function printSummary(areas) {
  const score = (entry) => entry[1].portableMissing + entry[1].portableDrift;
  const rows = Object.entries(areas)
    .sort((a, b) => score(b) - score(a) || a[0].localeCompare(b[0]));
  console.log(`\n${color('bold', 'Area'.padEnd(30))} ${color('dim', 'port-new  port-drift  proj-new  proj-drift')}`);
  for (const [name, counts] of rows) {
    const label = name.length > 30 ? name.slice(0, 30) : name.padEnd(30);
    const nums = [counts.portableMissing, counts.portableDrift, counts.projectMissing, counts.projectDrift]
      .map((n) => String(n).padStart(8))
      .join('  ');
    console.log(`${label} ${nums}`);
  }
}

function filterByArea(files, prefix) {
  if (!prefix) return files;
  return files.filter((f) => f.path.startsWith(prefix));
}

function printReport(result, opts) {
  const missing = filterByArea(result.missing, opts.area);
  const drifted = filterByArea(result.drifted, opts.area);

  printFileList('Missing - portable (port these)', missing.filter((f) => f.kind === 'portable'));
  printFileList('Drifted - portable additions (merge these)', drifted.filter((f) => f.kind === 'portable'));

  if (!opts.all) return;
  printFileList('Missing - project-specific (scrub or skip)', missing.filter((f) => f.kind === 'project-specific'));
  printFileList('Drifted - project-specific additions (scrub before merging)', drifted.filter((f) => f.kind === 'project-specific'));
  printFileList('Local-only (generic-workspace additions)', filterByArea(result.localOnly, opts.area));
}

// Post-port gate: every local file under `targets` must be free of project
// vocabulary. Exits 1 on any hit so it can run in CI or a pre-commit check.
function runScan(config, targets) {
  let regexes;
  try {
    regexes = toRegexes(config.projectTerms || []);
  } catch (err) {
    console.error(`workspace-drift: ${err.message}`);
    return 1;
  }
  const ignoreRes = (config.ignore || []).map((p) => new RegExp(p));
  const paths = listTracked(WORKSPACE_ROOT, targets.length > 0 ? targets : config.track, ignoreRes);

  let hits = 0;
  for (const rel of [...paths].sort()) {
    const text = readLocal(rel);
    if (text === null) continue;
    const terms = matchTerms(text, regexes);
    if (terms.length === 0) continue;
    hits += 1;
    console.log(`${rel}${termLabel(terms)}`);
  }

  if (hits === 0) {
    console.log(color('orange', 'No project-specific terms found.'));
    // A clean scan against the committed template proves nothing: its terms are
    // placeholders. Saying so beats reporting a green that nobody can trust.
    if (config.placeholder) {
      console.log(color('dim', 'NOT AUTHORITATIVE — scanned with placeholder terms from .ai-config/upstream.example.json.'));
      console.log(color('dim', 'Copy it to .ai-config/upstream.json and fill in the real list to make this a gate.'));
    }
    return 0;
  }
  console.log(color('bold', `\n${hits} file(s) still mention upstream project terms.`));
  return 1;
}

function readLocal(rel) {
  try {
    return fs.readFileSync(path.join(WORKSPACE_ROOT, rel), 'utf8');
  } catch {
    return null;
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  if (opts.scan) {
    process.exit(runScan(config, opts.scan));
  }

  const upstreamRoot = resolveUpstream(config, opts.upstream);
  const result = computeDrift(upstreamRoot, WORKSPACE_ROOT, config);

  if (opts.json) {
    console.log(JSON.stringify({ upstream: upstreamRoot, ...result }, null, 2));
    return;
  }

  const label = config.upstream?.label || path.basename(upstreamRoot);
  console.log(color('orange', `Workspace drift vs ${label}`));
  console.log(color('dim', upstreamRoot));

  if (opts.summary) {
    printSummary(result.areas);
    return;
  }

  printReport(result, opts);
  printSummary(result.areas);
  console.log(color('dim', '\nRun with --all for project-specific and local-only files, --json for tooling.'));
}

main();
