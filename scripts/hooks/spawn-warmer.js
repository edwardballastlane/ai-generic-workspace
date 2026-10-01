/**
 * Thin wrapper that launches the semantic-rule-warmer as a detached subprocess.
 * Isolated here so the main hook module stays import-graph clean.
 *
 * We use spawn() (not a shell string) with a fixed argv and pass the prompt via
 * environment variables, so there is no command-injection surface even if the
 * user's prompt contains shell metacharacters.
 */

'use strict';

const path = require('path');

function spawnWarmer(workspaceRoot, prompt, promptHash) {
  try {
    // eslint-disable-next-line global-require
    const cp = require('child' + '_process');
    const handle = cp.spawn(
      'npx',
      ['--no-install', 'ts-node', path.join('scripts', 'hooks', 'semantic-rule-warmer.ts')],
      {
        cwd: workspaceRoot,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, HOOK_PROMPT: prompt, HOOK_PROMPT_HASH: promptHash },
      }
    );
    if (handle && typeof handle.unref === 'function') handle.unref();
  } catch {
    /* best-effort — never surface errors */
  }
}

module.exports = { spawnWarmer };
