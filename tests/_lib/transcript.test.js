'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readTranscript } = require('../../scripts/_lib/transcript');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'transcript-min.jsonl');

function writeTempJsonl(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-test-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

test('readTranscript sums usage across assistant messages', async () => {
  const t = await readTranscript(FIXTURE);
  assert.equal(t.tokens.input, 300);
  assert.equal(t.tokens.cacheCreation, 50);
  assert.equal(t.tokens.cacheRead, 5000);
  assert.equal(t.tokens.output, 230);
});

test('readTranscript returns last assistant model', async () => {
  const t = await readTranscript(FIXTURE);
  assert.equal(t.model, 'claude-opus-4-7');
});

test('readTranscript collects substantive user prompts (non-meta, non-tag)', async () => {
  const t = await readTranscript(FIXTURE);
  assert.equal(t.userPrompts.length, 2);
  assert.match(t.userPrompts[0], /PROJ-123/);
  assert.equal(t.userPrompts[1], 'now optimize the query');
});

test('readTranscript returns zeros for missing file', async () => {
  const t = await readTranscript('/does/not/exist.jsonl');
  assert.equal(t.tokens.input, 0);
  assert.equal(t.tokens.output, 0);
  assert.equal(t.model, '');
  assert.deepEqual(t.userPrompts, []);
  assert.equal(t.lastUsage, null);
});

test('readTranscript lastUsage equals final usage block when multiple usage rows exist', async () => {
  const file = writeTempJsonl([
    { type: 'assistant', message: { model: 'claude-opus-4-7', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 } } },
    { type: 'assistant', message: { model: 'claude-opus-4-7', usage: { input_tokens: 200, output_tokens: 75, cache_read_input_tokens: 2000, cache_creation_input_tokens: 20 } } },
    { type: 'assistant', message: { model: 'claude-opus-4-7', usage: { input_tokens: 333, output_tokens: 111, cache_read_input_tokens: 3000, cache_creation_input_tokens: 30 } } },
  ]);
  const t = await readTranscript(file);
  assert.equal(t.lastUsage.input_tokens, 333);
  assert.equal(t.lastUsage.output_tokens, 111);
  assert.equal(t.lastUsage.cache_read_input_tokens, 3000);
  assert.equal(t.lastUsage.cache_creation_input_tokens, 30);
});

test('readTranscript lastUsage is null when transcript has no usage rows', async () => {
  const file = writeTempJsonl([
    { type: 'user', message: { content: 'hello there, this is a substantive prompt' } },
    { type: 'system', message: { content: 'system note' } },
  ]);
  const t = await readTranscript(file);
  assert.equal(t.lastUsage, null);
});

test('readTranscript sums cache_creation 5m vs 1h TTL breakdown separately', async () => {
  const file = writeTempJsonl([
    { type: 'assistant', message: { model: 'claude-opus-4-7', usage: {
      input_tokens: 0, output_tokens: 0,
      cache_creation_input_tokens: 100,
      cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 70 }
    }}},
    { type: 'assistant', message: { model: 'claude-opus-4-7', usage: {
      input_tokens: 0, output_tokens: 0,
      cache_creation_input_tokens: 200,
      cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 150 }
    }}},
  ]);
  const t = await readTranscript(file);
  assert.equal(t.tokens.cacheCreation, 300, 'aggregate cacheCreation still sums');
  assert.equal(t.tokens.cacheCreation5m, 80, '5m breakdown sums across messages');
  assert.equal(t.tokens.cacheCreation1h, 220, '1h breakdown sums across messages');
});

test('readTranscript leaves 5m/1h breakdown at zero when transcript has only legacy aggregate', async () => {
  const file = writeTempJsonl([
    { type: 'assistant', message: { model: 'claude-opus-4-7', usage: {
      input_tokens: 0, output_tokens: 0,
      cache_creation_input_tokens: 100
      // no cache_creation block — older transcript shape
    }}},
  ]);
  const t = await readTranscript(file);
  assert.equal(t.tokens.cacheCreation, 100);
  assert.equal(t.tokens.cacheCreation5m, 0);
  assert.equal(t.tokens.cacheCreation1h, 0);
});
