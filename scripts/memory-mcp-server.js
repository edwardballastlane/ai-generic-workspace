#!/usr/bin/env node
'use strict';

/**
 * lane-memory — an MCP stdio server exposing Lane's typed-observation memory to
 * the agent LIVE, mid-session: agent-callable, typed, scoped per project.
 *
 * Dependency-free: speaks MCP's newline-delimited JSON-RPC 2.0 over stdio by hand
 * (no SDK → no new deps → npm ci stays green). Backed by scripts/_lib/memory-store.js.
 *
 * IMPORTANT: stdout carries the protocol — ALL diagnostics go to stderr.
 *
 * Register in .mcp.json:
 *   "lane-memory": { "command": "node", "args": ["scripts/memory-mcp-server.js"] }
 */

const fs = require('node:fs');
const path = require('node:path');
const store = require('./_lib/memory-store');

const PROTOCOL_VERSION = '2024-11-05';

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

const ROOT = findWorkspaceRoot();
const log = (...a) => process.stderr.write(`[lane-memory] ${a.join(' ')}\n`);

// Token-efficient result serialization (TOON). Opt-in
// via LANE_TOON=1: a results-array (mem_search / mem_context) is emitted as TOON — the
// field names once + comma rows — instead of key-repeating JSON (~30–60% fewer tokens on
// the hot recall path). Any other shape, or when off, stays JSON. See scripts/_lib/toon.js.
function serialize(out) {
  if (process.env.LANE_TOON === '1' && out && Array.isArray(out.results)) {
    try { return require('./_lib/toon').encode(out.results, { name: 'results' }); } catch { /* fall back to JSON */ }
  }
  return JSON.stringify(out);
}

const TOOLS = [
  {
    name: 'mem_save',
    description: 'Save a typed memory observation (decision, bugfix, architecture, pattern, config, discovery, preference, feature). Call this proactively after a design decision, a non-obvious fix, or a convention you learned — without being asked.',
    inputSchema: {
      type: 'object',
      required: ['title', 'content'],
      properties: {
        title: { type: 'string', description: 'Short one-line title' },
        content: { type: 'string', description: 'Markdown: what / why / where / learned' },
        type: { type: 'string', enum: store.OBS_TYPES },
        tags: { type: 'array', items: { type: 'string' } },
        project: { type: 'string' },
        scope: { type: 'string', enum: store.SCOPES },
        sessionId: { type: 'string' },
      },
    },
  },
  {
    name: 'mem_search',
    description: 'Search saved memory observations by keyword. Use before starting work to recall prior decisions/fixes/conventions.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        type: { type: 'string', enum: store.OBS_TYPES },
        project: { type: 'string' },
        scope: { type: 'string', enum: store.SCOPES },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'mem_context',
    description: 'Return the most recent memory observations (for grounding at session start).',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, limit: { type: 'number' }, scope: { type: 'string', enum: store.SCOPES } },
    },
  },
  {
    name: 'mem_get_observation',
    description: 'Fetch one full (untruncated) observation by id.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
  },
  {
    name: 'mem_session_summary',
    description: 'Record a session summary (a session_summary observation) before declaring work done or after compaction.',
    inputSchema: {
      type: 'object',
      required: ['title', 'content'],
      properties: {
        title: { type: 'string' }, content: { type: 'string' },
        sessionId: { type: 'string' }, project: { type: 'string' },
      },
    },
  },
];

// Tool arguments arrive from the model, so they are input at a system boundary:
// take only the fields the schema declares and bound `limit`. Forwarding the raw
// object let a caller set `includeInjected`/`includeSuperseded` — flags the schema
// never advertises, which re-surface rules the prompt hook already injected and
// observations that were deliberately superseded — or ask for an unbounded result
// set and blow up the reply.
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 5;

function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_LIMIT);
}

function searchOpts(a) {
  return { type: a.type, project: a.project, scope: a.scope, limit: clampLimit(a.limit) };
}

// The WRITE path needs the same treatment, and needs it more. normalize() honours
// obs.id, obs.source, obs.ts, obs.valid_from, obs.valid_to, obs.superseded_by and
// obs.revision, none of which mem_save declares — so a raw spread let the model
// store a record that is invisible to its own search (source: 'rules-shared' is
// filtered by INJECTED_SOURCES, a truthy valid_to reads as superseded) or silently
// drop the write entirely by reusing an existing id.
function saveOpts(a) {
  return {
    title: a.title,
    content: a.content,
    type: a.type,
    tags: a.tags,
    project: a.project,
    scope: a.scope,
    sessionId: a.sessionId,
  };
}

function callTool(name, args) {
  const a = args || {};
  switch (name) {
    case 'mem_save': {
      const saved = store.saveObservation(ROOT, { ...saveOpts(a), local: true });
      return { ok: true, id: saved.id, type: saved.type, scope: saved.scope };
    }
    case 'mem_search':
      return { results: store.searchObservations(ROOT, a.query, searchOpts(a)) };
    case 'mem_context':
      return { results: store.recentContext(ROOT, { project: a.project, scope: a.scope, limit: clampLimit(a.limit) }) };
    case 'mem_get_observation':
      return { observation: store.getObservation(ROOT, a.id) };
    case 'mem_session_summary': {
      const saved = store.saveObservation(ROOT, { ...saveOpts(a), type: 'session_summary', local: true });
      return { ok: true, id: saved.id };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function handle(msg) {
  // Notifications (no id) get no response.
  if (msg.id === undefined || msg.id === null) {
    return null;
  }
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });

  try {
    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: (msg.params && msg.params.protocolVersion) || PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'lane-memory', version: '1.0.0' },
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const { name, arguments: args } = msg.params || {};
        // Semantic search is opt-in + async; every other tool is sync.
        // Returning a Promise here is fine — the stdin dispatch awaits responses in order.
        let semantic = false;
        try { semantic = (name === 'mem_search') && require('./_lib/memory-embed').semanticEnabled(); } catch { /* embed lib missing */ }
        if (semantic) {
          return store.searchObservationsSemantic(ROOT, (args || {}).query, searchOpts(args || {}))
            .then((results) => reply({ content: [{ type: 'text', text: serialize({ results }) }], isError: false }))
            .catch((err) => reply({ content: [{ type: 'text', text: `error: ${err.message}` }], isError: true }));
        }
        try {
          const out = callTool(name, args);
          return reply({ content: [{ type: 'text', text: serialize(out) }], isError: false });
        } catch (err) {
          return reply({ content: [{ type: 'text', text: `error: ${err.message}` }], isError: true });
        }
      }
      default:
        return fail(-32601, `method not found: ${msg.method}`);
    }
  } catch (err) {
    return fail(-32603, err.message);
  }
}

function main() {
  let buf = '';
  // Serialize responses through a chain so an async (semantic) reply still writes in
  // arrival order relative to sync replies.
  let writeChain = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { log('bad JSON line dropped'); continue; }
      const res = handle(msg);
      if (res === null || res === undefined) continue;
      writeChain = writeChain.then(async () => {
        const r = await res;
        if (r) process.stdout.write(JSON.stringify(r) + '\n');
      });
    }
  });
  process.stdin.on('end', () => process.exit(0));
  log(`ready (root=${ROOT})`);
}

if (require.main === module) main();

module.exports = { handle, callTool, TOOLS, findWorkspaceRoot };
