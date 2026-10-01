'use strict';

// upstream-drift.js — compare this generic workspace against an upstream
// (project-coupled) workspace it was forked from, and classify every
// difference as a port candidate, a project-specific file, or local-only.
//
// Consumed by scripts/workspace-drift.js and the port-upstream skill.

const fs = require('node:fs');
const path = require('node:path');

const TEXT_EXT = new Set([
  '.js', '.cjs', '.mjs', '.ts', '.tsx', '.json', '.md', '.sh', '.bash',
  '.yaml', '.yml', '.py', '.txt', '.html', '.css', '.sql', '',
]);

const MAX_COMPARE_BYTES = 512 * 1024;

function isComparable(relPath) {
  return TEXT_EXT.has(path.extname(relPath).toLowerCase());
}

// Terms are case-insensitive by default, because most project vocabulary is
// prose. A term written as `/pattern/flags` supplies its own flags instead —
// needed for an uppercase ticket prefix like `/\bANN\b/g`, which case-folded
// would match ordinary identifiers (`const ann = ...`) and bury the gate in
// false positives.
// Flags are REQUIRED after the closing slash, so a path-shaped term like
// `/opt/acme/` stays a literal pattern instead of silently compiling to
// /opt\/acme/ and losing its case-insensitivity.
const EXPLICIT_RE = /^\/(.*)\/([gimsuy]+)$/;

function toRegexes(terms) {
  return terms.map((t) => {
    const m = EXPLICIT_RE.exec(t);
    const source = m ? m[1] : t;
    const flags = m ? m[2] : 'gi';
    try {
      return { term: t, re: new RegExp(source, flags.includes('g') ? flags : `${flags}g`) };
    } catch (err) {
      throw new Error(`projectTerms entry ${JSON.stringify(t)} is not a valid regex: ${err.message}`);
    }
  });
}

function matchTerms(text, regexes) {
  const hits = [];
  for (const { term, re } of regexes) {
    re.lastIndex = 0;
    const count = (text.match(re) || []).length;
    if (count > 0) hits.push({ term, count });
  }
  return hits;
}

function ignored(relPath, ignoreRes) {
  return ignoreRes.some((re) => re.test(relPath));
}

function walk(root, rel, ignoreRes, out) {
  const abs = path.join(root, rel);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (ignored(childRel, ignoreRes)) continue;
    if (entry.isDirectory()) {
      walk(root, childRel, ignoreRes, out);
      continue;
    }
    if (entry.isFile()) out.add(childRel);
  }
  return out;
}

// Collect every tracked relative path under `root`, honouring config.track
// (recursive dirs or single files) and config.ignore.
// Targets arrive from config AND from the CLI, where a trailing slash is natural
// (`--scan docs/`). Left unnormalized it produces `docs//file.md`, which no
// `^docs/...$` ignore pattern matches — so the ignore list silently stops working
// for exactly the invocation a person is most likely to type.
function normalizeEntry(entry) {
  return String(entry).replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\.\//, '');
}

function listTracked(root, track, ignoreRes) {
  const out = new Set();
  for (const raw of track || []) {
    const entry = normalizeEntry(raw);
    if (!entry) continue;
    const abs = path.join(root, entry);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(root, entry, ignoreRes, out);
    else if (!ignored(entry, ignoreRes)) out.add(entry);
  }
  return out;
}

function readText(root, relPath) {
  const abs = path.join(root, relPath);
  try {
    const stat = fs.statSync(abs);
    if (stat.size > MAX_COMPARE_BYTES) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

// Lines present upstream but absent locally. A trimmed-line set difference,
// not a real diff — enough to tell whether upstream's additions drag in
// project-specific vocabulary.
function addedLines(upstreamText, localText) {
  const localSet = new Set(localText.split('\n').map((l) => l.trim()));
  return upstreamText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !localSet.has(l));
}

function lineCount(text) {
  return text === null ? 0 : text.split('\n').length;
}

function classifyMissing(relPath, upstreamRoot, regexes) {
  const text = readText(upstreamRoot, relPath);
  if (text === null) {
    return { path: relPath, status: 'missing', kind: 'binary-or-large', terms: [], lines: 0 };
  }
  const terms = matchTerms(text, regexes);
  return {
    path: relPath,
    status: 'missing',
    kind: terms.length > 0 ? 'project-specific' : 'portable',
    terms,
    lines: lineCount(text),
  };
}

function classifyDrift(relPath, upstreamRoot, localRoot, regexes) {
  const up = readText(upstreamRoot, relPath);
  const local = readText(localRoot, relPath);
  if (up === null || local === null) return null;
  if (up === local) return null;
  const added = addedLines(up, local);
  const terms = matchTerms(added.join('\n'), regexes);
  return {
    path: relPath,
    status: 'drifted',
    kind: terms.length > 0 ? 'project-specific' : 'portable',
    terms,
    lines: lineCount(up),
    localLines: lineCount(local),
    addedLines: added.length,
  };
}

function area(relPath) {
  const parts = relPath.split('/');
  if (parts.length === 1) return '(root)';
  if (parts.length === 2) return parts[0];
  return `${parts[0]}/${parts[1]}`;
}

/**
 * @returns {{missing: object[], drifted: object[], localOnly: object[], areas: object}}
 */
function computeDrift(upstreamRoot, localRoot, config) {
  const ignoreRes = (config.ignore || []).map((p) => new RegExp(p));
  const regexes = toRegexes(config.projectTerms || []);
  const track = config.track || [];

  const upstream = listTracked(upstreamRoot, track, ignoreRes);
  const local = listTracked(localRoot, track, ignoreRes);

  const missing = [];
  const drifted = [];
  for (const rel of upstream) {
    if (!local.has(rel)) {
      missing.push(classifyMissing(rel, upstreamRoot, regexes));
      continue;
    }
    if (!isComparable(rel)) continue;
    const d = classifyDrift(rel, upstreamRoot, localRoot, regexes);
    if (d) drifted.push(d);
  }

  const localOnly = [...local]
    .filter((rel) => !upstream.has(rel))
    .map((rel) => ({ path: rel, status: 'local-only', kind: 'local', terms: [], lines: 0 }));

  const sortByPath = (a, b) => a.path.localeCompare(b.path);
  missing.sort(sortByPath);
  drifted.sort(sortByPath);
  localOnly.sort(sortByPath);

  return { missing, drifted, localOnly, areas: summarizeAreas(missing, drifted) };
}

function summarizeAreas(missing, drifted) {
  const areas = {};
  const bump = (rel, bucket) => {
    const key = area(rel);
    areas[key] ||= { portableMissing: 0, projectMissing: 0, portableDrift: 0, projectDrift: 0 };
    areas[key][bucket] += 1;
  };
  for (const f of missing) bump(f.path, f.kind === 'portable' ? 'portableMissing' : 'projectMissing');
  for (const f of drifted) bump(f.path, f.kind === 'portable' ? 'portableDrift' : 'projectDrift');
  return areas;
}

module.exports = {
  normalizeEntry,
  computeDrift,
  listTracked,
  addedLines,
  matchTerms,
  toRegexes,
  area,
  isComparable,
};
