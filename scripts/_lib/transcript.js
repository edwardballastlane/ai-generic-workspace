'use strict';

const fs = require('node:fs');
const readline = require('node:readline');

function emptyResult() {
  return {
    tokens: { input: 0, output: 0, cacheRead: 0,
      cacheCreation: 0, cacheCreation5m: 0, cacheCreation1h: 0 },
    model: '',
    userPrompts: [],
    lastUsage: null,
  };
}

/**
 * Read a Claude Code JSONL transcript and extract token usage, the last
 * assistant model name, and substantive user prompts.
 *
 * @param {string} filePath - Absolute path to the .jsonl transcript file.
 * @returns {Promise<{tokens: {input, output, cacheRead, cacheCreation, cacheCreation5m, cacheCreation1h}, model: string, userPrompts: string[], lastUsage: object|null}>}
 */
async function readTranscript(filePath) {
  if (!filePath) return emptyResult();

  // createReadStream fires 'error' asynchronously on missing files, so check
  // existence synchronously before opening the stream.
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
  } catch {
    return emptyResult();
  }

  const tokens = { input: 0, output: 0, cacheRead: 0,
    cacheCreation: 0, cacheCreation5m: 0, cacheCreation1h: 0 };
  let model = '';
  const userPrompts = [];
  let lastUsage = null;

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }

      const usage = row.message && row.message.usage;
      if (usage) {
        tokens.input += usage.input_tokens || 0;
        tokens.output += usage.output_tokens || 0;
        tokens.cacheRead += usage.cache_read_input_tokens || 0;
        tokens.cacheCreation += usage.cache_creation_input_tokens || 0;
        const ccBreak = usage.cache_creation || {};
        tokens.cacheCreation5m += ccBreak.ephemeral_5m_input_tokens || 0;
        tokens.cacheCreation1h += ccBreak.ephemeral_1h_input_tokens || 0;
        lastUsage = usage;
      }

      const msgModel = row.message && row.message.model;
      if (msgModel) model = msgModel;

      if (
        row.type === 'user' &&
        row.isMeta !== true &&
        row.message &&
        typeof row.message.content === 'string' &&
        !row.message.content.startsWith('<') &&
        row.message.content.length > 10
      ) {
        userPrompts.push(row.message.content);
      }
    }
  } catch {
    // partial read — return what we have so far
  }

  return { tokens, model, userPrompts, lastUsage };
}

module.exports = { readTranscript };
