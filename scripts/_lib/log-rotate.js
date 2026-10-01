'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { atomicWrite } = require('./process');

/**
 * Cap a log file to its last `keepBytes` bytes when it exceeds `maxBytes`.
 * Mirrors `stat -c%s` + `tail -c` in session-stop.sh:238-243 — byte-exact.
 *
 * Uses synchronous read so the tail is captured in one shot without
 * double-buffering through a stream.
 *
 * @param {string} filePath  - Absolute path to the log file.
 * @param {number} maxBytes  - Rotate when file size exceeds this.
 * @param {number} keepBytes - Bytes to retain from the end of the file.
 * @returns {Promise<void>}
 */
async function rotateIfTooLarge(filePath, maxBytes, keepBytes) {
  let size;
  try {
    const st = await fs.stat(filePath);
    size = st.size;
  } catch {
    return;
  }
  if (size <= maxBytes) return;

  const fd = fsSync.openSync(filePath, 'r');
  try {
    const start = Math.max(0, size - keepBytes);
    const buf = Buffer.alloc(size - start);
    fsSync.readSync(fd, buf, 0, buf.length, start);
    await atomicWrite(filePath, buf);
  } finally {
    fsSync.closeSync(fd);
  }
}

module.exports = { rotateIfTooLarge };
