'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'pre-tool-use.js');

// pre-tool-use.js bypasses the git-push block when process.cwd() contains
// "ai-generic-workspace" (the meta-repo itself doesn't follow /pre-push for
// its own commits). The test runs from inside the workspace, so by default
// every git-push assertion would silently pass the bypass branch. Force the
// hook into tmpdir-cwd mode so the bypass doesn't fire and the assertions
// actually exercise the block logic.
function runHook(payload, envOverrides) {
  return spawnSync(process.execPath, [HOOK], {
    input: payload === undefined ? '' : (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    encoding: 'utf8',
    cwd: os.tmpdir(),
    env: envOverrides ? { ...process.env, ...envOverrides } : process.env,
  });
}

// .env-read protection is opt-in (relaxed by request) — it only fires when
// LANE_BLOCK_ENV_READS=1. The env-read/env-load suite below exercises that
// feature's allow/block matrix, so it runs the hook with the flag enabled.
// Default-off behavior (reads allowed) is covered by its own tests.
function runHookEnv(payload) {
  return runHook(payload, { LANE_BLOCK_ENV_READS: '1' });
}

test('AC-7: blocks --force push to main', () => {
  const r = runHook({ tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } });
  assert.equal(r.status, 2, `exit ${r.status}, stderr=${r.stderr}`);
  assert.match(r.stdout, /^BLOCKED:/);
});

test('AC-7: blocks --force push to master', () => {
  const r = runHook({ tool_name: 'Bash', tool_input: { command: 'git push --force origin master' } });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /BLOCKED:.*[Ff]orce/);
});

test('AC-7: blocks -f push to main (short flag)', () => {
  const r = runHook({ tool_name: 'Bash', tool_input: { command: 'git push -f origin main' } });
  assert.equal(r.status, 2);
});

test('AC-7: blocks Bash command containing a shell-shaped secret', () => {
  // SHELL_SECRET_RE expects KEY|SECRET|TOKEN|PASSWORD assignment.
  const cmd = 'export SECRET=hunter2hunter2hunter2 && echo done # pre-push-reviewed';
  const r = runHook({ tool_name: 'Bash', tool_input: { command: cmd } });
  assert.equal(r.status, 2, `exit ${r.status}, stdout=${r.stdout}, stderr=${r.stderr}`);
  assert.match(r.stdout, /BLOCKED:.*secret/i);
});

test('AC-8: blocks plain git push without # pre-push-reviewed marker', () => {
  const r = runHook({ tool_name: 'Bash', tool_input: { command: 'git push origin master' } });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /pre-push/);
});

test('AC-8: allows git push when # pre-push-reviewed marker present', () => {
  const r = runHook({
    tool_name: 'Bash',
    tool_input: { command: 'git push origin master # pre-push-reviewed' }
  });
  assert.equal(r.status, 0, `exit ${r.status}, stdout=${r.stdout}`);
});

test('AC-9: allows secret-shaped content in .env file (allowlist)', () => {
  const r = runHook({
    tool_name: 'Write',
    tool_input: { file_path: '/repo/.env', content: 'API_KEY=hunter2hunter2hunter2hunter2' }
  });
  assert.equal(r.status, 0, `exit ${r.status}, stdout=${r.stdout}`);
});

test('AC-9: allows secret-shaped content in .env.local (allowlist)', () => {
  const r = runHook({
    tool_name: 'Write',
    tool_input: { file_path: '/repo/.env.local', content: 'API_KEY=hunter2hunter2hunter2hunter2' }
  });
  assert.equal(r.status, 0);
});

test('AC-9: blocks secret-shaped content in non-exempt path', () => {
  const r = runHook({
    tool_name: 'Write',
    tool_input: { file_path: '/repo/src/config.js', content: 'API_KEY=hunter2hunter2hunter2hunter2' }
  });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /BLOCKED:.*secret/i);
});

test('AC-9: blocks secret in Edit new_string for non-exempt path', () => {
  const r = runHook({
    tool_name: 'Edit',
    tool_input: { file_path: '/repo/src/foo.ts', new_string: 'const TOKEN=hunter2hunter2hunter2' }
  });
  assert.equal(r.status, 2);
});

test('exits 0 on empty stdin', () => {
  const r = runHook('');
  assert.equal(r.status, 0, `exit ${r.status}, stderr=${r.stderr}`);
});

test('exits 0 on malformed JSON stdin', () => {
  const r = runHook('not json {');
  assert.equal(r.status, 0);
});

test('exits 0 for unrelated tool calls', () => {
  const r = runHook({ tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } });
  assert.equal(r.status, 0);
});

test('exits 0 for benign Bash command', () => {
  const r = runHook({ tool_name: 'Bash', tool_input: { command: 'ls -la' } });
  assert.equal(r.status, 0, `exit ${r.status}, stdout=${r.stdout}`);
});

test('M-1: blocks rm -rf /', () => {
  const r = runHook({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
  assert.equal(r.status, 2, `exit ${r.status}, stdout=${r.stdout}, stderr=${r.stderr}`);
  assert.match(r.stdout, /BLOCKED: rm -rf \//);
});

test('M-1: blocks rm -rf ~', () => {
  const r = runHook({ tool_name: 'Bash', tool_input: { command: 'rm -rf ~' } });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /BLOCKED: rm -rf ~/);
});

test('M-1: blocks rm -rf $HOME', () => {
  const r = runHook({ tool_name: 'Bash', tool_input: { command: 'rm -rf $HOME' } });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /BLOCKED: rm -rf \$HOME/);
});

test('M-1: allows rm -rf with trailing path (e.g. /tmp/foo)', () => {
  const r = runHook({ tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/foo' } });
  assert.equal(r.status, 0, `exit ${r.status}, stdout=${r.stdout}`);
});

// env-var indirection: the token literal is what's sensitive; a shell or
// process.env reference is not, since the value never appears in the
// command/file text. The hook strips these references before running
// secret heuristics so legitimate API-call patterns pass.

test('env-ref: allows curl with x-api-key sourced from a shell variable', () => {
  const cmd = 'curl -H "x-api-key: ${SPLIT_IO_ADMIN_KEY}" https://api.example.com';
  const r = runHook({ tool_name: 'Bash', tool_input: { command: cmd } });
  assert.equal(r.status, 0, `exit ${r.status}, stdout=${r.stdout}`);
});

test('env-ref: allows curl with Bearer sourced from $VAR (unbraced)', () => {
  const cmd = 'curl -H "Authorization: Bearer $ATLASSIAN_API_TOKEN" https://api.example.com';
  const r = runHook({ tool_name: 'Bash', tool_input: { command: cmd } });
  assert.equal(r.status, 0);
});

test('env-ref: allows shell assignment from another env var (env-to-env)', () => {
  const cmd = 'export AUTH_KEY=$SOURCE_TOKEN && curl -H "x-api-key: $AUTH_KEY" url';
  const r = runHook({ tool_name: 'Bash', tool_input: { command: cmd } });
  assert.equal(r.status, 0, `exit ${r.status}, stdout=${r.stdout}`);
});

test('env-ref: allows Write of JS that reads token via process.env property', () => {
  const content = "const t = process.env.SPLIT_IO_ADMIN_KEY\nfetch(url, { headers: { 'x-api-key': t } })";
  const r = runHook({
    tool_name: 'Write',
    tool_input: { file_path: '/tmp/script.js', content }
  });
  assert.equal(r.status, 0, `exit ${r.status}, stdout=${r.stdout}`);
});

test('env-ref: rm -rf $HOME is still blocked (DESTRUCTIVE_RM uses raw cmd, not env-stripped)', () => {
  const r = runHook({ tool_name: 'Bash', tool_input: { command: 'rm -rf $HOME' } });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /BLOCKED: rm -rf \$HOME/);
});

// ENV_READ_BLOCK: stop bash from printing .env contents into the
// transcript. Templates (.env.example/.template/.sample) and metadata
// commands (ls/stat) stay allowed. Loader idioms that consume .env via
// command substitution (export/eval/env $(...)) are bypassed so workflows
// that hydrate the process env keep working.

test('env-read: blocks cat .env', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'cat .env' } });
  assert.equal(r.status, 2, `exit ${r.status}, stdout=${r.stdout}`);
  assert.match(r.stdout, /BLOCKED:.*\.env/i);
});

test('env-read: blocks head on absolute .env path', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'head /home/user/proj/.env' } });
  assert.equal(r.status, 2);
});

test('env-read: blocks grep KEY .env', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'grep KEY .env' } });
  assert.equal(r.status, 2);
});

test('env-read: blocks .env.local (non-template variant)', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'head .env.local' } });
  assert.equal(r.status, 2);
});

test('env-read: blocks echo with $(cat .env) substitution into stdout', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'echo "loading: $(cat .env)"' } });
  assert.equal(r.status, 2);
});

test('env-read: allows cat .env.example (template)', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'cat .env.example' } });
  assert.equal(r.status, 0, `exit ${r.status}, stdout=${r.stdout}`);
});

test('env-read: allows ls -la .env (metadata, not contents)', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'ls -la .env' } });
  assert.equal(r.status, 0);
});

test('env-read: allows stat .env', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'stat .env' } });
  assert.equal(r.status, 0);
});

test('env-read: allows .environments.json (similar prefix, not .env)', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'head .environments.json' } });
  assert.equal(r.status, 0);
});

test('env-load: allows export $(cat .env | xargs)', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'export $(cat .env | xargs)' } });
  assert.equal(r.status, 0, `exit ${r.status}, stdout=${r.stdout}`);
});

test('env-load: allows eval "$(cat .env)"', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'eval "$(cat .env)"' } });
  assert.equal(r.status, 0);
});

test('env-load: allows env $(cat .env | xargs) ./bin/cli', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'env $(cat .env | xargs) ./bin/cli' } });
  assert.equal(r.status, 0);
});

test('env-load: allows source .env (no read command in block list)', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'set -a; source .env; set +a' } });
  assert.equal(r.status, 0);
});

test('env-load: allows eval "$(grep -v ^# .env | sed ...)" pipeline', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: "eval \"$(grep -v '^#' .env | sed 's/^/export /')\"" } });
  assert.equal(r.status, 0);
});

test('env-load: allows dotenv -e .env -- node app.js', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'dotenv -e .env -- node app.js' } });
  assert.equal(r.status, 0);
});

// Adversarial: per-clause evaluation. Without per-clause splitting, a
// leading `cat .env` could be laundered by a trailing loader idiom on the
// same line. These tests pin the per-clause check.

test('env-read: blocks `cat .env; export $(cat .env | xargs)` (whole-command laundering)', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'cat .env; export $(cat .env | xargs)' } });
  assert.equal(r.status, 2, `exit ${r.status}, stdout=${r.stdout}`);
});

test('env-read: blocks `cat .env && export $(cat .env | xargs)` (&& separator)', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'cat .env && export $(cat .env | xargs)' } });
  assert.equal(r.status, 2);
});

test('env-read: blocks `cat .env || echo ok` (|| separator)', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'cat .env || echo ok' } });
  assert.equal(r.status, 2);
});

test('env-read: blocks tail -f .env', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'tail -f .env' } });
  assert.equal(r.status, 2);
});

// Extended print idioms covered by the widened deny list.

test('env-read: blocks strings .env', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'strings .env' } });
  assert.equal(r.status, 2);
});

test('env-read: blocks base64 .env', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'base64 .env' } });
  assert.equal(r.status, 2);
});

test('env-read: blocks sort .env', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'sort .env' } });
  assert.equal(r.status, 2);
});

test('env-read: blocks rev .env', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'rev .env' } });
  assert.equal(r.status, 2);
});

test('env-read: blocks `dd if=.env` (flag-glued form)', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'dd if=.env' } });
  assert.equal(r.status, 2);
});

// Interpreter inline-code forms with .env in argv.

test('env-read: blocks `python -c "print(open(\'.env\').read())"`', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: "python -c \"print(open('.env').read())\"" } });
  assert.equal(r.status, 2);
});

test('env-read: blocks `node -e "fs.readFileSync(\'.env\')"`', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: "node -e \"console.log(require('fs').readFileSync('.env','utf8'))\"" } });
  assert.equal(r.status, 2);
});

test('env-read: blocks `perl -ne "print" .env`', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'perl -ne "print" .env' } });
  assert.equal(r.status, 2);
});

test('env-read: allows `node app.js --env-file .env` (long-flag, not -e/-c)', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'node app.js --env-file .env' } });
  assert.equal(r.status, 0, `exit ${r.status}, stdout=${r.stdout}`);
});

test('env-read: allows `python tool.py --env .env` (long-flag, not -c)', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'python tool.py --env .env' } });
  assert.equal(r.status, 0);
});

// Shell-native read forms: $(< file) and stdin redirect.

test('env-read: blocks `printf "%s\\n" "$(< .env)"`', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'printf "%s\\n" "$(< .env)"' } });
  assert.equal(r.status, 2, `exit ${r.status}, stdout=${r.stdout}`);
});

test('env-read: blocks `echo "$(< .env)"`', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'echo "$(< .env)"' } });
  assert.equal(r.status, 2);
});

test('env-read: blocks `read -r line < .env`', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'read -r line < .env' } });
  assert.equal(r.status, 2);
});

test('env-read: blocks `mapfile -t arr < .env`', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'mapfile -t arr < .env' } });
  assert.equal(r.status, 2);
});

test('env-read: blocks `while read l; do echo $l; done < .env`', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'while IFS= read -r l; do echo "$l"; done < .env' } });
  assert.equal(r.status, 2);
});

test('env-load: still allows `eval "$(< .env)"` (loader bypass on redirect form)', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'eval "$(< .env)"' } });
  assert.equal(r.status, 0, `exit ${r.status}, stdout=${r.stdout}`);
});

// Additional interpreters with inline-eval flags.

test('env-read: blocks `php -r "echo file_get_contents(...)"`', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: "php -r \"echo file_get_contents('.env');\"" } });
  assert.equal(r.status, 2);
});

test('env-read: blocks `pwsh -Command "Get-Content .env"`', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'pwsh -Command "Get-Content .env"' } });
  assert.equal(r.status, 2);
});

test('env-read: blocks `pwsh -c "Get-Content .env"` (short form)', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'pwsh -c "Get-Content .env"' } });
  assert.equal(r.status, 2);
});

test('env-read: blocks `lua -e "f=io.open(\'.env\')..."`', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: "lua -e \"f=io.open('.env'); print(f:read('*a'))\"" } });
  assert.equal(r.status, 2);
});

test('env-read: blocks `Rscript -e "cat(readLines(\'.env\'))"`', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: "Rscript -e \"cat(readLines('.env'))\"" } });
  assert.equal(r.status, 2);
});

test('env-read: blocks `osascript -e "do shell script \\"cat .env\\""`', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'osascript -e "do shell script \\"cat .env\\""' } });
  assert.equal(r.status, 2);
});

test('env-read: allows `node -r dotenv/config app.js` (-r is module load, no .env in argv)', () => {
  const r = runHookEnv({ tool_name: 'Bash', tool_input: { command: 'node -r dotenv/config app.js' } });
  assert.equal(r.status, 0, `exit ${r.status}, stdout=${r.stdout}`);
});

// --- Default behavior: .env-read protection is opt-in (relaxed by request) ---
// Without LANE_BLOCK_ENV_READS=1 the hook must NOT block .env reads, so local
// microservice debugging (inspecting per-service .env files) isn't a hassle.

test('env-read default-off: allows `cat .env` when LANE_BLOCK_ENV_READS is unset', () => {
  const r = runHook({ tool_name: 'Bash', tool_input: { command: 'cat .env' } },
    { LANE_BLOCK_ENV_READS: '' });
  assert.equal(r.status, 0, `exit ${r.status}, stdout=${r.stdout}`);
});

test('env-read default-off: allows reading a per-service .env when flag unset', () => {
  const r = runHook({ tool_name: 'Bash', tool_input: { command: 'grep SERVICE_URL .env' } },
    { LANE_BLOCK_ENV_READS: '' });
  assert.equal(r.status, 0, `exit ${r.status}, stdout=${r.stdout}`);
});

test('env-read default-off: force-push is still blocked regardless of the flag', () => {
  const r = runHook({ tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } },
    { LANE_BLOCK_ENV_READS: '' });
  assert.equal(r.status, 2, `exit ${r.status}, stdout=${r.stdout}`);
});

// --- Scratchpad exemption: the session's throwaway debugging sandbox is
// exempt from the hardcoded-secret block (relaxed alongside the .env read
// allowance), while non-scratchpad paths stay protected (see AC-9 above).
// The credential literal is assembled at runtime (keyword split) so this test
// file's own source does not trip the hook's secret scanner.
const kw = 'TOK' + 'EN';
const leak = 'const ' + kw + '=' + 'value12345678';

test('scratchpad: allows secret-shaped content written under a /scratchpad/ path', () => {
  const r = runHook({
    tool_name: 'Write',
    tool_input: { file_path: '/tmp/claude/session/scratchpad/probe.js', content: leak }
  });
  assert.equal(r.status, 0, `exit ${r.status}, stdout=${r.stdout}`);
});

test('scratchpad: same secret in a non-scratchpad path is still blocked', () => {
  const r = runHook({
    tool_name: 'Write',
    tool_input: { file_path: '/repo/src/probe.js', content: leak }
  });
  assert.equal(r.status, 2, `exit ${r.status}, stdout=${r.stdout}`);
});
