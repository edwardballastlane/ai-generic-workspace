'use strict';

/**
 * toon — Token-Oriented Object Notation: a compact, token-efficient array-of-objects
 * encoding for LLM I/O. Encodes a uniform
 * array as ONE header (the field names, once) + comma-separated rows, dropping the repeated
 * JSON keys/braces — ~30–60% fewer tokens on tabular data. Directly reduces the token cost
 * of Lane's `mem_search`/`mem_context` results (the hot agent-facing structured path).
 *
 * Subset by design: flat objects. A value containing `,` `"` or a newline is JSON-quoted so
 * the row stays parseable; arrays/objects are kept as a JSON token. Pure and
 * round-trippable for flat rows, with one documented exception: an empty string
 * decodes back as null, because the wire format cannot distinguish them.
 *
 * Shape:  data[3]{id,type,title}:
 *           obs_1,bugfix,Fix the thing
 *           obs_2,decision,"Chose X, not Y"
 */

function needsQuote(s) { return /[",\n]/.test(s); }

function encodeVal(v) {
  if (v == null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') return JSON.stringify(v);          // array/object → JSON token
  const s = String(v);
  return needsQuote(s) ? JSON.stringify(s) : s;
}

/** Union of keys across rows, in first-seen order. */
function fieldsOf(rows) {
  const seen = [];
  const set = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    for (const k of Object.keys(r || {})) if (!set.has(k)) { set.add(k); seen.push(k); }
  }
  return seen;
}

/**
 * Encode a uniform array of flat objects to TOON.
 * @param {object[]} rows
 * @param {{name?: string, fields?: string[]}} [opts]  name = the array's label; fields = column subset/order
 * @returns {string}
 */
function encode(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const name = opts.name || 'data';
  const fields = opts.fields || fieldsOf(list);
  const header = `${name}[${list.length}]{${fields.join(',')}}:`;
  const lines = list.map((r) => '  ' + fields.map((f) => encodeVal(r ? r[f] : undefined)).join(','));
  return [header, ...lines].join('\n');
}

/**
 * Split a TOON row on TOP-LEVEL commas only — commas inside a JSON-quoted string or
 * inside a `[...]`/`{...}` token (e.g. the array `["x","y"]`) are kept intact.
 */
function splitRow(line) {
  const out = [];
  let cur = '';
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inStr) { cur += c; if (c === '"' && line[i - 1] !== '\\') inStr = false; continue; }
    if (c === '"') { inStr = true; cur += c; continue; }
    if (c === '[' || c === '{') { depth += 1; cur += c; continue; }
    if (c === ']' || c === '}') { depth -= 1; cur += c; continue; }
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function decodeVal(s) {
  if (s === '') return null;
  if (s[0] === '"' || s[0] === '[' || s[0] === '{') { try { return JSON.parse(s); } catch { return s; } }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

/** Decode TOON back to an array of objects. Returns [] on a malformed header. */
function decode(toon) {
  const lines = String(toon == null ? '' : toon).split('\n').filter((l) => l.length);
  if (!lines.length) return [];
  const m = lines[0].match(/^(\w+)\[(\d+)\]\{([^}]*)\}:$/);
  if (!m) return [];
  const fields = m[3] ? m[3].split(',') : [];
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitRow(lines[i].replace(/^\s+/, ''));
    const o = {};
    fields.forEach((f, idx) => { o[f] = decodeVal(cells[idx] == null ? '' : cells[idx]); });
    rows.push(o);
  }
  return rows;
}

module.exports = { encode, decode, fieldsOf, encodeVal };
