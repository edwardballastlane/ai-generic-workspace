'use strict';

const fs = require('node:fs');
const { looksLikeSecret, looksLikeShellSecret } = require('../_lib/heuristics');

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch {}
if (!raw) { try { raw = fs.readFileSync('/dev/stdin', 'utf8'); } catch {} }
if (!raw) process.exit(0);

let payload;
try { payload = JSON.parse(raw); } catch { process.exit(0); }

const tool = (payload && payload.tool_name) || '';
const input = (payload && payload.tool_input) || {};

function block(reason) {
  console.log(`BLOCKED: ${reason}`);
  process.exit(2);
}

const FORCE_PUSH_LONG = /git\s+push\s+.*--force.*\s+(main|master)/;
const FORCE_PUSH_SHORT = /git\s+push\s+.*-f.*\s+(main|master)/;
const GIT_PUSH = /git\s+push/;
const ENV_ALLOWLIST = /\.env(\.|$)|\.example$|\.template$|\.sample$/;

// Block bash commands that would print/exfiltrate the contents of a real
// .env file. .env.example / .env.template / .env.sample are templates and
// remain readable. Programs that consume .env (node, npm, dotenv-cli) load
// it themselves and are not affected.
//
// Evaluated per top-level clause (split on ; && || newline) so a leading
// `cat .env` can't be laundered by a trailing loader idiom on the same
// line. Splitting skips content inside $(...) and backticks because
// substitution contents are consumed by the surrounding command, not
// executed as a separate clause.
//
// Residual risk: an attacker can still leak via shell state laundering
// (e.g. `eval $(echo "X=$(cat .env)"); echo $X` — value lands in $X via
// eval, then prints with no .env reference in the printing clause), or
// via a custom interpreter script the regex doesn't know about. The block
// targets accidental leaks from Claude commands, not adversarial input.
const ENV_READ_BLOCK = /\b(cat|tac|head|tail|less|more|bat|view|nl|xxd|od|hexdump|cp|mv|tee|grep|egrep|fgrep|rg|awk|sed|strings|base64|base32|sort|shuf|rev|md5sum|sha256sum|sha1sum|tar)\b[^|;&]*?\.env\b(?!\.(?:example|template|sample))/i;

// `dd if=.env` is a print-style read but the `if=` syntax glues the path
// to the flag, so the generic ENV_READ_BLOCK can't reach it.
const ENV_DD_BLOCK = /\bdd\s+if=[^|;&\s]*?\.env\b(?!\.(?:example|template|sample))/i;

// Bash's native `$(< file)` reads file content without invoking any
// command, and `< .env` is the same gap when a wrapping command
// (printf/echo/read/mapfile/while-read) consumes the redirected stdin.
// Path-side rule so we don't need to enumerate every consumer. The
// surrounding clause may still be allowed by ENV_LOAD_BYPASS (e.g.
// `eval "$(< .env)"`), which is checked at the clause level.
const ENV_REDIRECT_BLOCK = /(?:<\s*\.env\b|\$\(\s*<\s*\.env\b)(?!\.(?:example|template|sample))/i;

// Inline-code interpreters. Split per interpreter family because the
// evaluator-flag letter set diverges (Perl combines -ne/-pe/-paE, PHP
// uses -r, PowerShell uses -c/-Command, lua/Rscript/osascript use -e).
// Non-evaluator flags (-m, -B, -O for python; -r for node module load;
// long-form --env-file) don't match, so legitimate data-flag usage is
// preserved.
const ENV_INTERPRETER_PATTERNS = [
  /\b(python3?|node|deno|ruby|perl)\b[^|;&]*?\s-[ceEpna]+\b[^|;&]*?\.env\b(?!\.(?:example|template|sample))/i,
  /\bphp\b[^|;&]*?\s-r\b[^|;&]*?\.env\b(?!\.(?:example|template|sample))/i,
  /\b(pwsh|powershell)\b[^|;&]*?\s-(?:c|Command)\b[^|;&]*?\.env\b(?!\.(?:example|template|sample))/i,
  /\b(lua|Rscript|osascript)\b[^|;&]*?\s-e\b[^|;&]*?\.env\b(?!\.(?:example|template|sample))/i,
];

// Loader idioms where .env contents flow into argv/env via command
// substitution rather than to stdout. Allow these even when they contain
// a read command (cat/grep/etc.) inside the $(...).
const ENV_LOAD_BYPASS = /\b(export|eval|env)\s+["']?\$\([^)]*\.env\b/i;

// Split on top-level clause separators only. Skip separators that fall
// inside $(...) or `...` so a substitution body stays attached to its
// consumer when we evaluate ENV_LOAD_BYPASS. Pipes (|) are intentionally
// not split: a pipe feeds one stage's stdout to the next, so a leading
// `cat .env` still needs the bypass to apply to the whole pipeline.
function splitTopLevelClauses(cmd) {
  const out = [];
  let buf = '';
  let parenDepth = 0;
  let inBackticks = false;
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    const pair = cmd.slice(i, i + 2);
    if (inBackticks) {
      if (ch === '`') inBackticks = false;
      buf += ch; i++; continue;
    }
    if (ch === '`') { inBackticks = true; buf += ch; i++; continue; }
    if (pair === '$(') { parenDepth++; buf += pair; i += 2; continue; }
    if (parenDepth > 0 && ch === ')') { parenDepth--; buf += ch; i++; continue; }
    if (parenDepth === 0) {
      if (ch === ';' || ch === '\n') { out.push(buf); buf = ''; i++; continue; }
      if (pair === '&&' || pair === '||') { out.push(buf); buf = ''; i += 2; continue; }
    }
    buf += ch; i++;
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

function clauseReadsEnv(clause) {
  return ENV_READ_BLOCK.test(clause)
    || ENV_DD_BLOCK.test(clause)
    || ENV_REDIRECT_BLOCK.test(clause)
    || ENV_INTERPRETER_PATTERNS.some((p) => p.test(clause));
}

const DESTRUCTIVE_RM = [
  { re: /\brm\s+-rf?\s+\/\s*$/, label: 'rm -rf /' },
  { re: /\brm\s+-rf?\s+~\s*$/, label: 'rm -rf ~' },
  { re: /\brm\s+-rf?\s+\$HOME\s*$/, label: 'rm -rf $HOME' },
];

// Replace credential-by-reference patterns with two consecutive quotes
// so the literal-secret heuristics don't fire when the value is loaded
// from an env var rather than hardcoded. Two quotes terminate both
// SECRET_RE's `\S{4,}` value scan and SHELL_SECRET_RE's value scan
// (the second quote ends the non-quote run), preventing false positives
// on patterns like an assignment followed by `&&` or another command.
// Optional leading backslash is consumed so escaped forms in JS template
// strings or shell heredocs collapse cleanly. Keeps heuristics.js strict
// for session-stop logging and transcript backfill callers — this
// relaxation applies only at the tool boundary.
function stripEnvRefs(s) {
  return s
    .replace(/\\?\$\{[A-Za-z_][A-Za-z0-9_]*(?::[-+?][^}]*)?\}/g, '""')
    .replace(/\\?\$[A-Za-z_][A-Za-z0-9_]*/g, '""')
    .replace(/\bprocess\.env\.[A-Za-z_][A-Za-z0-9_]*/g, '""')
    .replace(/\bprocess\.env\[["'][A-Za-z_][A-Za-z0-9_]*["']\]/g, '""');
}

// Reading JWTs / Bearer tokens is allowed by request: short-lived user session
// tokens are routinely needed to drive authenticated local test calls
// (lambda-exec, curl against a service). Strip JWT and Bearer tokens from the
// secret-check at the tool boundary so they don't trip the hardcoded-secret
// block. AWS keys, gh/sk- tokens, and credential-assignment shapes are
// unaffected and still blocked. heuristics.js stays strict for session-stop
// logging / transcript backfill — this relaxation is tool-boundary only,
// mirroring stripEnvRefs.
function stripJwtRefs(s) {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, 'Bearer ""')
    .replace(/eyJ[A-Za-z0-9._=-]{20,}/g, '""');
}

if (tool === 'Bash') {
  const cmd = String(input.command || '');

  // guard:population force-push fail-closed: legitimate pushes to main/master are non-force; --force/-f is blocked (only a human may override branch protection)
  if (FORCE_PUSH_LONG.test(cmd) || FORCE_PUSH_SHORT.test(cmd)) {
    // refusal:by-design human-authority — only a human may override branch protection
    block('Force push to main/master is not allowed');
  }

  // guard:population git-push fail-closed: legitimate pushes are workspace pushes or /pre-push-reviewed ones; other-repo pushes are blocked
  const isWorkspacePush = GIT_PUSH.test(cmd) && (
    cmd.includes('ai-generic-workspace') ||
    (process.cwd() || '').includes('ai-generic-workspace')
  );
  if (GIT_PUSH.test(cmd) && !cmd.includes('# pre-push-reviewed') && !isWorkspacePush) {
    block('Use /pre-push instead of git push. This ensures lessons are reviewed by a separate agent before pushing.');
  }

  // guard:population secret-command fail-closed: legitimate commands reference secrets via env vars (${VAR}/process.env); hardcoded secret literals are blocked
  const cmdForSecretCheck = stripJwtRefs(stripEnvRefs(cmd));
  if (looksLikeSecret(cmdForSecretCheck) || looksLikeShellSecret(cmdForSecretCheck)) {
    block('Possible hardcoded secret detected in command. Remove it or load from an env var (e.g. `${VAR}` / process.env.X) instead.');
  }

  // .env read protection is opt-in. It was relaxed by request so local
  // microservice debugging (inspecting/editing service URLs in per-service
  // .env files) isn't a hassle. Re-enable by exporting LANE_BLOCK_ENV_READS=1
  // for the Claude Code process. Force-push / destructive-rm / hardcoded-secret
  // checks remain active regardless.
  // guard:population env-read too-tight: legitimate .env access is via loaders (source/dotenv); printing real .env contents is blocked (opt-in)
  if (process.env.LANE_BLOCK_ENV_READS === '1') {
    for (const clause of splitTopLevelClauses(cmd)) {
      if (clauseReadsEnv(clause) && !ENV_LOAD_BYPASS.test(clause)) {
        block('Printing .env contents is blocked to prevent secrets in the transcript. Safe loaders that don\'t print: `source .env`, `set -a; . .env; set +a`, or a dotenv CLI. To inspect variable names use .env.example / .env.template / .env.sample.');
      }
    }
  }

  // guard:population destructive-rm fail-closed: legitimate rm targets are project paths; rm -rf of / ~ $HOME is blocked
  for (const { re, label } of DESTRUCTIVE_RM) {
    if (re.test(cmd)) block(label);
  }
}

if (tool === 'Write' || tool === 'Edit') {
  const filePath = String(input.file_path || '');
  const content = String(input.content != null ? input.content : (input.new_string || ''));
  // Scratchpad is the session's throwaway debugging sandbox (tokens, fixtures,
  // probe scripts) — exempt it from the hardcoded-secret block so debugging
  // isn't a hassle. Relaxed by request alongside the .env read allowance.
  const isScratchpad = /[/\\]scratchpad[/\\]/.test(filePath);
  const exempt = ENV_ALLOWLIST.test(filePath) || isScratchpad;
  if (!exempt) {
    // guard:population secret-content fail-closed: legitimate written content references secrets via env vars or documented placeholder examples; real hardcoded secret literals are blocked
    const contentForSecretCheck = stripEnvRefs(content);
    if (looksLikeSecret(contentForSecretCheck) || looksLikeShellSecret(contentForSecretCheck)) {
      block(`Possible hardcoded secret detected in ${tool} content. Remove it or reference an env var (e.g. process.env.X) instead.`);
    }
  }
}

process.exit(0);
