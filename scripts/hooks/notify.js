#!/usr/bin/env node
/* eslint-disable no-empty */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { findWorkspaceRoot } = require('./_lib/workspace-root');

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch {}
if (!raw) {
  try { raw = fs.readFileSync('/dev/stdin', 'utf8'); } catch {}
}
if (!raw) process.exit(0);

let payload;
try { payload = JSON.parse(raw); } catch { process.exit(0); }
if (!payload || typeof payload !== 'object') process.exit(0);

const record = {
  type: 'notification',
  ts: new Date().toISOString(),
  session_id: payload.session_id || '',
  level: payload.level || 'info',
  message: payload.message || payload.text || '',
  source: payload.source || 'claude-code',
};

try {
  const root = findWorkspaceRoot();
  const dir = path.join(root, '.claude', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'notifications.jsonl'), JSON.stringify(record) + '\n');
} catch {}

process.exit(0);
