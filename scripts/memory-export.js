#!/usr/bin/env node
'use strict';

/**
 * memory-export — share LOCALLY-AUTHORED observations across the team,
 * using a committed per-contributor chunk model.
 *
 * Chunks are plain JSONL (reviewable + diff-able in PRs) named per git-user, under
 * .ai-memory/observations-export/ (git-tracked via a .gitignore allowlist). Because
 * each person owns their own <name>.jsonl, chunks never merge-conflict.
 *
 * Dedup / no-double-loading guarantees:
 *  - export ships only `local === true` observations (authored on THIS machine), so a
 *    teammate's imported observation is never re-exported through your chunk.
 *  - import writes with `local:false` and dedups by id (idempotent; re-import adds 0;
 *    importing your OWN chunk back is a no-op).
 *
 * Usage:
 *   node scripts/memory-export.js export [--name <chunk>]
 *   node scripts/memory-export.js import
 *   node scripts/memory-export.js share            # export + git add + PR hint
 */

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteSync } = require('./_lib/process');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const store = require('./_lib/memory-store');
const { isNoiseSummary, containsSensitiveData, inferProject } = require('./_lib/summary-quality');

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

function exportDir(root) { return path.join(root, '.ai-memory', 'observations-export'); }
function chunkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') || f.endsWith('.jsonl.gz')).sort();
}

/** A filesystem-safe chunk name (default: the git user, else "shared"). */
function defaultChunkName(root) {
  const r = spawnSync('git', ['config', 'user.name'], { cwd: root, encoding: 'utf8' });
  const raw = (r.status === 0 ? r.stdout : '').trim() || 'shared';
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'shared';
}

/** Write this machine's LOCAL observations to a plain-JSONL chunk + refresh the manifest. */
function exportChunk(root, name) {
  const dir = exportDir(root);
  fs.mkdirSync(dir, { recursive: true });
  // Share only local observations. Gate what leaves this machine:
  //  - drop noise session_summaries (prompt leaks, log-session, bare tickets, follow-ups);
  //  - drop ANY observation carrying real sensitive data (CLAUDE.md rule 12), all types;
  //  - backfill the `project` field from content so the board/filters stay useful.
  // See summary-quality.js.
  const obs = store.readAll(root, ['project'])
    .filter((o) => o.local === true)
    .filter((o) => !o.valid_to)                 // don't share superseded records
    .filter((o) => !isNoiseSummary(o))
    .filter((o) => !containsSensitiveData(o))
    .map((o) => (o.project ? o : { ...o, project: inferProject(o) }));
  const jsonl = obs.map((o) => JSON.stringify(o)).join('\n') + (obs.length ? '\n' : '');
  const chunkFile = path.join(dir, `${name}.jsonl`);
  atomicWriteSync(chunkFile, jsonl);
  refreshManifest(root);
  return { file: path.relative(root, chunkFile), count: obs.length };
}

function refreshManifest(root) {
  const dir = exportDir(root);
  const manifest = { version: 1, chunks: chunkFiles(dir).filter((f) => f !== 'manifest.json') };
  atomicWriteSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

/** Import every chunk into the local project store as `local:false` (idempotent, batched). */
function importChunks(root) {
  const dir = exportDir(root);
  const files = chunkFiles(dir);
  if (!files.length) return { chunks: 0, added: 0 };
  const existing = new Set(store.readAll(root, ['project']).map((o) => o.id));
  const toAppend = [];
  for (const f of files) {
    const buf = fs.readFileSync(path.join(dir, f));
    const text = f.endsWith('.gz') ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const full = store.normalize({ ...o, scope: 'project', local: false });
      if (existing.has(full.id)) continue;          // dedup by id — never load the same obs twice
      existing.add(full.id);
      toAppend.push(JSON.stringify(full));
    }
  }
  if (toAppend.length) {
    const file = store.scopeFile(root, 'project');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, toAppend.join('\n') + '\n');
  }
  return { chunks: files.length, added: toAppend.length };
}

/** A cheap signature of the export dir (names+size+mtime) for change-detection. */
function signatureOf(root) {
  const dir = exportDir(root);
  return chunkFiles(dir).map((f) => {
    try { const st = fs.statSync(path.join(dir, f)); return `${f}:${st.size}:${Math.floor(st.mtimeMs)}`; }
    catch { return `${f}:?`; }
  }).join('|');
}

function main() {
  const root = findWorkspaceRoot();
  const cmd = process.argv[2];
  if (cmd === 'export' || cmd === 'share') {
    const i = process.argv.indexOf('--name');
    const name = i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : defaultChunkName(root);
    const r = exportChunk(root, name);
    if (cmd === 'share') {
      try { spawnSync('git', ['add', path.join('.ai-memory', 'observations-export')], { cwd: root, stdio: 'ignore' }); } catch {}
      console.log(`memory-share: exported ${r.count} observation(s) → ${r.file} and staged it. Commit + open a PR to share with the team.`);
    } else {
      console.log(`memory-export: wrote ${r.count} observation(s) → ${r.file}`);
    }
  } else if (cmd === 'import') {
    const r = importChunks(root);
    console.log(`memory-export: imported ${r.chunks} chunk(s), ${r.added} new observation(s) added`);
  } else {
    console.error('usage: memory-export.js <export|import|share> [--name <chunk>]');
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { exportDir, chunkFiles, defaultChunkName, exportChunk, importChunks, refreshManifest, signatureOf, findWorkspaceRoot };
