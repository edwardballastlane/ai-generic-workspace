#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { findWorkspaceRoot } = require('./_lib/workspace-root');
const { readTranscript } = require('../_lib/transcript');

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch {}
if (!raw) {
  try { raw = fs.readFileSync('/dev/stdin', 'utf8'); } catch {}
}

if (!raw) process.exit(0);

let payload;
try { payload = JSON.parse(raw); } catch { process.exit(0); }
if (!payload || typeof payload !== 'object') process.exit(0);

// Mirrors subagent-stop.sh: preview is sliced from `last_assistant_message`
// in the payload itself — CC delivers it inline; we don't read the transcript.
const lastMessage = typeof payload.last_assistant_message === 'string'
  ? payload.last_assistant_message
  : '';

const transcriptPath = payload.agent_transcript_path || '';

async function main() {
  // Capture which model this subagent actually ran on — lets the token
  // dashboard attribute cost by model and verify tiered routing is working.
  let model = '';
  try {
    if (transcriptPath) {
      ({ model } = await readTranscript(transcriptPath));
    }
  } catch { /* best-effort */ }

  const record = {
    type: 'subagent_stop',
    ts: new Date().toISOString(),
    session_id: payload.session_id || '',
    agent_id: payload.agent_id || '',
    agent_type: payload.agent_type || 'unknown',
    model,
    permission_mode: payload.permission_mode || '',
    transcript_path: transcriptPath,
    last_message_preview: lastMessage.slice(0, 200),
  };

  try {
    const root = findWorkspaceRoot();
    const dir = path.join(root, '.claude', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'subagent-events.jsonl'), JSON.stringify(record) + '\n');
  } catch { /* never block CC */ }
}

main().finally(() => process.exit(0));
