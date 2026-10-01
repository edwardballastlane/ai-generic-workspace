'use strict';

/**
 * pr-summary — build a RICH session_summary from a PR-creation command.
 *
 * The session-stop fallback can only guess a task from the first user prompt; at
 * PR-creation time we have the real thing — the PR title + description the human/agent
 * wrote — so this produces a far better summary. Written under a deterministic per-session
 * id ("sess_<id>") so it supersedes any thin fallback (memory-store readAll is
 * last-write-wins by id), and so session-stop's "already has a summary?" guard skips the
 * thin write. Pure + dependency-free → unit-testable; the hook wires it to the store.
 */

/** Shell-ish tokenizer that respects single/double quotes. Returns bare tokens. */
function tokenize(cmd) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(cmd || '')))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function flagValue(tokens, names) {
  for (let i = 0; i < tokens.length; i += 1) {
    for (const n of names) {
      if (tokens[i].startsWith(n + '=')) return tokens[i].slice(n.length + 1);   // --flag=value
    }
    if (names.includes(tokens[i]) && i + 1 < tokens.length) return tokens[i + 1]; // --flag value
  }
  return '';
}

/**
 * Parse {title, body} from a PR/MR-create command across the platforms Lane targets.
 * Handles gh/glab/az flag forms and the positional `bitbucket-pr create` form.
 *
 * @param {string} cmd
 * @returns {{title: string, body: string}}
 */
function parsePrFromCmd(cmd) {
  const tokens = tokenize(cmd);
  // Positional: bitbucket-pr create <ws> <repo> <source> <target> "<title>" "<desc>" ...
  const bbIdx = tokens.findIndex((t) => t.endsWith('bitbucket-pr'));
  if (bbIdx !== -1 && tokens[bbIdx + 1] === 'create') {
    const rest = tokens.slice(bbIdx + 2);       // ws repo source target title desc ...
    return { title: rest[4] || '', body: rest[5] || '' };
  }
  // Flag forms: gh pr create --title --body; glab/az --title --description.
  const title = flagValue(tokens, ['--title', '-t']);
  const body = flagValue(tokens, ['--body', '-b', '--description', '-d']);
  return { title: title || '', body: body || '' };
}

/**
 * Build a rich session_summary {title, content} from a PR command + session context,
 * or null when there's no usable title (e.g. --body-file only). Truncates for storage.
 *
 * @param {{cmd: string, ticket?: string, project?: string, filesTouched?: string[]}} ctx
 * @returns {{title: string, content: string}|null}
 */
function buildPrSummary(ctx = {}) {
  const { cmd = '', ticket = '', project = '', filesTouched = [] } = ctx;
  const { title, body } = parsePrFromCmd(cmd);
  if (!title || title.trim().length < 3) return null;   // nothing better than the fallback

  const files = Array.isArray(filesTouched) ? filesTouched : [];
  const lines = [`PR: ${title.trim()}`];
  if (ticket) lines.push(`Ticket: ${ticket}`);
  if (project) lines.push(`Project: ${project}`);
  if (files.length) {
    const shown = files.slice(0, 15).join(', ');
    lines.push(`Files: ${shown}${files.length > 15 ? ` (+${files.length - 15} more)` : ''}`);
  }
  if (body && body.trim()) lines.push('', body.trim());

  return {
    title: title.trim().slice(0, 200),
    content: lines.join('\n').slice(0, 2000),
  };
}

/** Deterministic per-session summary id shared by the PR-time and session-stop writers. */
function sessionSummaryId(sessionId) {
  return `sess_${sessionId}`;
}

module.exports = { parsePrFromCmd, buildPrSummary, sessionSummaryId, tokenize };
