'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// Pin the store root BEFORE requiring the server (it captures ROOT at load).
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memmcp-'));
process.env.WORKSPACE_ROOT = ROOT;
const server = require('../scripts/memory-mcp-server');

function call(method, params, id = 1) {
  return server.handle({ jsonrpc: '2.0', id, method, params });
}

test('initialize echoes protocol + serverInfo', () => {
  const r = call('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(r.result.protocolVersion, '2024-11-05');
  assert.equal(r.result.serverInfo.name, 'lane-memory');
  assert.ok(r.result.capabilities.tools);
});

test('a notification (no id) yields no response', () => {
  assert.equal(server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('tools/list returns the five memory tools', () => {
  const names = call('tools/list').result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['mem_context', 'mem_get_observation', 'mem_save', 'mem_search', 'mem_session_summary']);
});

test('mem_save → mem_search → mem_get_observation round-trips through the server', () => {
  const save = call('tools/call', { name: 'mem_save', arguments: { title: 'ratchet baseline design', content: 'freeze then forbid growth', type: 'decision', project: 'lane' } });
  const saved = JSON.parse(save.result.content[0].text);
  assert.equal(saved.ok, true);
  assert.ok(saved.id);

  const search = call('tools/call', { name: 'mem_search', arguments: { query: 'ratchet growth' } });
  const found = JSON.parse(search.result.content[0].text).results;
  assert.ok(found.length >= 1);
  assert.equal(found[0].id, saved.id);

  const get = call('tools/call', { name: 'mem_get_observation', arguments: { id: saved.id } });
  assert.equal(JSON.parse(get.result.content[0].text).observation.content, 'freeze then forbid growth');
});

test('mem_session_summary saves a session_summary-typed observation', () => {
  const r = call('tools/call', { name: 'mem_session_summary', arguments: { title: 's', content: 'did stuff', sessionId: 'S9' } });
  const out = JSON.parse(r.result.content[0].text);
  assert.equal(out.ok, true);
  const ctx = call('tools/call', { name: 'mem_context', arguments: { limit: 50 } });
  const results = JSON.parse(ctx.result.content[0].text).results;
  assert.ok(results.some((o) => o.type === 'session_summary' && o.id === out.id));
});

test('tools/call on an unknown tool returns isError, not a crash', () => {
  const r = call('tools/call', { name: 'no_such_tool', arguments: {} });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /unknown tool/);
});

test('unknown JSON-RPC method returns method-not-found', () => {
  const r = call('nonsense/method', {});
  assert.equal(r.error.code, -32601);
});

test('mem_save ignores schema-undeclared fields that would hide the record', () => {
  // normalize() honours obs.source / obs.valid_to / obs.revision, none of which
  // mem_save declares. Forwarded raw, a caller could store a record that is
  // invisible to its own search (INJECTED_SOURCES filters 'rules-shared'; a
  // truthy valid_to reads as superseded) while still getting {ok:true, id}.
  const save = call('tools/call', { name: 'mem_save', arguments: {
    title: 'cache invalidation approach',
    content: 'invalidate on write, not on read',
    source: 'rules-shared',
    valid_to: '2020-01-01T00:00:00Z',
    revision: 999,
  } });
  const saved = JSON.parse(save.result.content[0].text);
  assert.equal(saved.ok, true);

  const stored = JSON.parse(call('tools/call', { name: 'mem_get_observation', arguments: { id: saved.id } })
    .result.content[0].text).observation;
  assert.equal(stored.source, 'agent', 'source must not be settable by the caller');
  assert.equal(stored.valid_to, null, 'a save must not arrive pre-superseded');
  assert.equal(stored.revision, 0);

  const hits = JSON.parse(call('tools/call', { name: 'mem_search', arguments: { query: 'cache invalidation' } })
    .result.content[0].text).results;
  assert.ok(hits.some((o) => o.id === saved.id), 'the saved record must be findable by its own search');
});

test('mem_save cannot silently no-op by reusing an existing id', () => {
  const first = JSON.parse(call('tools/call', { name: 'mem_save', arguments: {
    title: 'original record', content: 'the one that was already there',
  } }).result.content[0].text);

  const second = JSON.parse(call('tools/call', { name: 'mem_save', arguments: {
    title: 'overwrite attempt', content: 'different content', id: first.id,
  } }).result.content[0].text);

  assert.notEqual(second.id, first.id, 'a caller-supplied id must not collide the write away');
  const original = JSON.parse(call('tools/call', { name: 'mem_get_observation', arguments: { id: first.id } })
    .result.content[0].text).observation;
  assert.equal(original.title, 'original record', 'the existing record must be untouched');
});

test('mem_session_summary applies the same whitelist', () => {
  const saved = JSON.parse(call('tools/call', { name: 'mem_session_summary', arguments: {
    title: 'session wrap-up', content: 'what happened', source: 'MEMORY.md', valid_to: '2020-01-01T00:00:00Z',
  } }).result.content[0].text);

  const stored = JSON.parse(call('tools/call', { name: 'mem_get_observation', arguments: { id: saved.id } })
    .result.content[0].text).observation;
  assert.equal(stored.type, 'session_summary');
  assert.equal(stored.source, 'agent');
  assert.equal(stored.valid_to, null);
});
