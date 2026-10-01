'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { spawn } = require('node:child_process');

/**
 * Write `contents` to `target` atomically via a temp file + rename.
 * Replaces the `tmp=$(mktemp); ... mv "$tmp" "$target"` pattern in bash.
 *
 * @param {string} target   - Destination file path.
 * @param {string} contents - Data to write.
 * @returns {Promise<void>}
 */
async function atomicWrite(target, contents) {
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, contents);
  await fs.rename(tmp, target);
}

/**
 * Synchronous atomicWrite, for the sync call sites that cannot become async
 * without refactoring their caller (prompt hooks, one-shot CLIs). Same
 * guarantee: a reader sees either the old file or the new one, never a
 * half-written one.
 *
 * @param {string} target
 * @param {string|Buffer} contents
 */
function atomicWriteSync(target, contents) {
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  fsSync.writeFileSync(tmp, contents);
  fsSync.renameSync(tmp, target);
}

/**
 * Run `fn` while holding an exclusive lock on `target` (a `${target}.lock`
 * marker file created with the `wx` flag, so only one holder can succeed).
 * Callers that need to read-modify-write the same file from concurrent
 * processes (e.g. hooks appending to a shared JSON sidecar) must wrap the
 * whole read+write in this — atomicWrite alone only makes the final write
 * atomic, it does nothing to serialize the read that precedes it, so two
 * overlapping read-modify-writes can still silently lose one side's update.
 *
 * A lock older than `staleMs` is assumed abandoned by a crashed holder and
 * is broken so the queue can't deadlock forever.
 *
 * @param {string} target
 * @param {() => Promise<T>} fn
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=5000] - Give up waiting for the lock after this long.
 * @param {number} [opts.staleMs=5000] - Treat a lock file older than this as abandoned.
 * @param {number} [opts.retryDelayMs=20] - Delay between acquisition attempts.
 * @returns {Promise<T>}
 * @template T
 */
async function withFileLock(target, fn, { timeoutMs = 5000, staleMs = 5000, retryDelayMs = 20 } = {}) {
  const lockPath = `${target}.lock`;
  const start = Date.now();
  for (;;) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.close();
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const { mtimeMs } = await fs.stat(lockPath);
        if (Date.now() - mtimeMs > staleMs) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between the failed open and this stat — retry acquiring it
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`withFileLock: timed out waiting for lock on ${target}`);
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lockPath, { force: true });
  }
}

/**
 * Read `target` as JSON (defaulting to `{}` if missing/invalid), pass it to
 * `mutate`, and atomically write back whatever `mutate` returns — the whole
 * cycle serialized via `withFileLock` so concurrent updaters can't clobber
 * each other. `mutate` returning `undefined` means "no change needed" and
 * skips the write entirely (e.g. the value being added is already present).
 *
 * @param {string} target
 * @param {(current: object) => (object|undefined)} mutate
 * @returns {Promise<object|undefined>} whatever `mutate` returned
 */
async function atomicUpdateJson(target, mutate) {
  return withFileLock(target, async () => {
    let current = {};
    try {
      current = JSON.parse(await fs.readFile(target, 'utf8'));
    } catch {
      // Missing or invalid JSON — mutate() gets a fresh object and decides what to do.
    }
    const next = await mutate(current);
    if (next === undefined) return undefined;
    await atomicWrite(target, JSON.stringify(next, null, 2));
    return next;
  });
}

/**
 * Spawn a child process detached from the current process, equivalent to
 * `nohup cmd args &>/dev/null & disown` in bash.
 *
 * The child is unref'd so the parent can exit without waiting for it.
 * Errors are swallowed — callers must not depend on the child's outcome.
 *
 * @param {string}   cmd      - Executable to run.
 * @param {string[]} args     - Argument list.
 * @param {object}   [opts={}] - Extra spawn options (merged after defaults).
 * @returns {{ pid: number|undefined, unrefCalled: true }}
 */
function spawnDetached(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    detached: true,
    stdio: 'ignore',
    ...opts,
  });
  child.unref();
  // Mirror the bash `disown` semantic: never await, never propagate errors.
  child.on('error', () => {});
  return { pid: child.pid, unrefCalled: true };
}

module.exports = { atomicWrite, atomicWriteSync, withFileLock, atomicUpdateJson, spawnDetached };
