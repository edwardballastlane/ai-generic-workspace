'use strict';

// Jira story-points fetcher used by:
//   - scripts/refresh-jira-story-points.js (manual / cron backfill)
//   - scripts/hooks/session-stop.js (incremental: 1 ticket per session)
//
// The dashboard never imports this — it reads the resulting cache file at
// .ai-memory/jira-story-points.json directly so teammates without Jira
// credentials still render the SP column.
//
// Atlassian's *scoped* API tokens (192-char ATATT3xF…) only authenticate via
// the api.atlassian.com gateway, not the bare site URL. We discover the site's
// cloudId once via the unauthenticated /_edge/tenant_info endpoint and use
// /ex/jira/{cloudId}/rest/api/3/... thereafter.

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const SP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SP_BATCH_SIZE = 10;
const HTTP_TIMEOUT_MS = 15000;

function spCachePath(rootDir) {
  return path.join(rootDir, '.ai-memory', 'jira-story-points.json');
}

function loadSpCache(rootDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(spCachePath(rootDir), 'utf8'));
    return {
      detected_field: raw.detected_field || null,
      cloud_id: raw.cloud_id || null,
      entries: raw.entries || {},
    };
  } catch { return { detected_field: null, cloud_id: null, entries: {} }; }
}

function saveSpCache(rootDir, cache) {
  const file = spCachePath(rootDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cache, null, 2));
}

function jiraAuthHeader() {
  const email = process.env.ATLASSIAN_EMAIL;
  const token = process.env.ATLASSIAN_JIRA_API_TOKEN || process.env.ATLASSIAN_API_TOKEN;
  if (!email || !token) return null;
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

function httpsGetJson(hostname, pathQ, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path: pathQ,
      method: 'GET',
      headers: { ...(headers || {}), Accept: 'application/json' },
    }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        } else {
          reject(new Error(`${hostname}${pathQ} → ${res.statusCode}: ${body.slice(0, 160)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || HTTP_TIMEOUT_MS, () => req.destroy(new Error('Request timeout')));
    req.end();
  });
}

async function discoverCloudId(siteUrl, timeoutMs) {
  const url = new URL(siteUrl);
  const info = await httpsGetJson(url.hostname, '/_edge/tenant_info', null, timeoutMs);
  if (!info || !info.cloudId) {
    throw new Error(`No cloudId at ${siteUrl}/_edge/tenant_info`);
  }
  return info.cloudId;
}

function jiraGet(cloudId, pathQ, auth, timeoutMs) {
  return httpsGetJson('api.atlassian.com', `/ex/jira/${cloudId}${pathQ}`, { Authorization: auth }, timeoutMs);
}

async function detectStoryPointField(cloudId, auth, timeoutMs) {
  const fields = await jiraGet(cloudId, '/rest/api/3/field', auth, timeoutMs);
  if (!Array.isArray(fields)) return null;
  const byExactName = fields.find(f => f && f.name === 'Story Points');
  if (byExactName) return byExactName.id;
  const byLoose = fields.find(f => /story\s*points?\b/i.test(f && f.name || ''));
  return byLoose ? byLoose.id : null;
}

async function fetchInBatches(items, fn, batchSize) {
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(fn));
    for (let j = 0; j < results.length; j++) out[i + j] = results[j];
  }
  return out;
}

// Fetches SP/assignee for `ticketKeys`, populating the cache at
// .ai-memory/jira-story-points.json. Returns { byTicket, available, reason,
// fetched, fromCache }. Safe to call from a hook: timeoutMs caps total per
// request; missing creds return immediately with reason='no-credentials'.
async function fetchStoryPoints(rootDir, siteUrl, ticketKeys, opts) {
  const options = opts || {};
  const timeoutMs = options.timeoutMs || HTTP_TIMEOUT_MS;
  const cacheTtlMs = options.cacheTtlMs != null ? options.cacheTtlMs : SP_CACHE_TTL_MS;
  const auth = jiraAuthHeader();
  if (!auth) {
    return { byTicket: {}, available: false, reason: 'no-credentials', fetched: 0, fromCache: 0 };
  }
  if (ticketKeys.length === 0) {
    return { byTicket: {}, available: true, reason: 'no-tickets', fetched: 0, fromCache: 0 };
  }
  const cache = loadSpCache(rootDir);
  if (!cache.cloud_id) {
    try {
      cache.cloud_id = await discoverCloudId(siteUrl, timeoutMs);
    } catch (err) {
      return { byTicket: {}, available: false, reason: 'cloud-id-failed', error: err.message, fetched: 0, fromCache: 0 };
    }
  }
  const cloudId = cache.cloud_id;
  try {
    await jiraGet(cloudId, '/rest/api/3/myself', auth, timeoutMs);
  } catch (err) {
    return { byTicket: {}, available: false, reason: 'bad-credentials', error: err.message, fetched: 0, fromCache: 0 };
  }
  if (!cache.detected_field) {
    try {
      cache.detected_field = await detectStoryPointField(cloudId, auth, timeoutMs);
    } catch (err) {
      return { byTicket: {}, available: false, reason: 'field-detect-failed', error: err.message, fetched: 0, fromCache: 0 };
    }
    if (!cache.detected_field) {
      return { byTicket: {}, available: false, reason: 'no-sp-field', fetched: 0, fromCache: 0 };
    }
    saveSpCache(rootDir, cache);
  }
  const spField = cache.detected_field;
  const now = Date.now();
  const fresh = {};
  const stale = [];
  for (const k of ticketKeys) {
    const cached = cache.entries[k];
    if (cached && cached.cached_at && (now - new Date(cached.cached_at).getTime()) < cacheTtlMs) {
      fresh[k] = cached;
    } else {
      stale.push(k);
    }
  }
  let fetched = 0;
  if (stale.length > 0) {
    const fieldsQ = encodeURIComponent(`${spField},assignee,status`);
    const results = await fetchInBatches(
      stale,
      k => jiraGet(cloudId, `/rest/api/3/issue/${encodeURIComponent(k)}?fields=${fieldsQ}`, auth, timeoutMs),
      SP_BATCH_SIZE
    );
    const now = new Date().toISOString();
    results.forEach((r, idx) => {
      const key = stale[idx];
      if (r.status !== 'fulfilled') {
        cache.entries[key] = { sp: 0, assignee: null, cached_at: now, error: true };
        return;
      }
      const issue = r.value;
      // E5 fix: distinguish "Jira returned a malformed response" (mark error)
      // from "ticket exists, SP field is null/0" (legitimate 0). Without this,
      // a malformed payload silently becomes "0 SP" identical to a real 0.
      const fields = issue && issue.fields;
      if (!fields || typeof fields !== 'object') {
        cache.entries[key] = { sp: 0, assignee: null, cached_at: now, error: true };
        return;
      }
      const rawSp = fields[spField];
      const sp = (rawSp == null) ? 0 : Number(rawSp);
      const assignee = fields.assignee && fields.assignee.displayName || null;
      // Capture the workflow status so the dashboard can distinguish delivered
      // SP (Done/Closed/Resolved) from merely-assigned SP. `done` keys off
      // Jira's statusCategory ("done"), which buckets Done/Closed/Resolved and
      // any custom terminal status — more robust than matching status names.
      const statusObj = fields.status;
      const status = statusObj && statusObj.name || null;
      const done = !!(statusObj && statusObj.statusCategory && statusObj.statusCategory.key === 'done');
      const prev = cache.entries[key];
      // W14 fix: only bump cached_at when the underlying value actually
      // changed. Otherwise the daily pipeline would rewrite every entry's
      // timestamp and produce a noisy whole-file diff on every run.
      const unchanged = prev && !prev.error && prev.sp === sp && prev.assignee === assignee
        && prev.status === status && prev.done === done;
      const entry = unchanged
        ? prev
        : { sp, assignee, status, done, cached_at: now };
      cache.entries[key] = entry;
      fresh[key] = entry;
      fetched++;
    });
    saveSpCache(rootDir, cache);
  }
  return {
    byTicket: fresh,
    available: true,
    reason: 'ok',
    spField,
    fetched,
    fromCache: ticketKeys.length - stale.length,
  };
}

// ---------------------------------------------------------------------------
// Delivered-tickets fetcher — the "delivered universe" for AI-coverage analysis.
//
// Unlike fetchStoryPoints (which is keyed by tickets already seen in AI
// sessions), this runs a JQL query for EVERY ticket closed in a window,
// regardless of whether AI touched it. The token dashboard diffs this set
// against the AI-tracked ticket set to surface work that shipped WITHOUT the
// workspace AI. Cached to .ai-memory/jira-period-tickets.json (git-tracked) so
// teammates without Jira credentials still render the coverage view.
// ---------------------------------------------------------------------------

const PERIOD_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const JQL_PAGE_SIZE = 100;
// The Jira project to query, from the same env var the rest of the workspace
// uses for ticket extraction. Read at call time so setup can set it without a
// restart. Unset means "no Jira project configured" — the coverage view then
// reports unavailable rather than querying somebody else's project key.
function jiraProject() {
  return process.env.JIRA_PREFIX || '';
}

function periodCachePath(rootDir) {
  return path.join(rootDir, '.ai-memory', 'jira-period-tickets.json');
}

function loadPeriodCache(rootDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(periodCachePath(rootDir), 'utf8'));
    return {
      detected_field: raw.detected_field || null,
      cloud_id: raw.cloud_id || null,
      window: raw.window || null,
      generated_at: raw.generated_at || null,
      entries: raw.entries || {},
    };
  } catch { return { detected_field: null, cloud_id: null, window: null, generated_at: null, entries: {} }; }
}

function savePeriodCache(rootDir, cache) {
  const file = periodCachePath(rootDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cache, null, 2));
}

// Enhanced-JQL search (GET /rest/api/3/search/jql) with token pagination.
// The legacy /rest/api/3/search (startAt/total) is deprecated on Jira Cloud;
// the new endpoint returns { issues, nextPageToken, isLast }.
async function searchJql(cloudId, jql, fields, auth, timeoutMs) {
  const issues = [];
  let nextPageToken = null;
  const fieldsQ = fields.map(encodeURIComponent).join(',');
  do {
    let q = `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=${fieldsQ}&maxResults=${JQL_PAGE_SIZE}`;
    if (nextPageToken) q += `&nextPageToken=${encodeURIComponent(nextPageToken)}`;
    const page = await jiraGet(cloudId, q, auth, timeoutMs);
    if (page && Array.isArray(page.issues)) issues.push(...page.issues);
    nextPageToken = (page && !page.isLast && page.nextPageToken) ? page.nextPageToken : null;
  } while (nextPageToken);
  return issues;
}

// Fetch every ticket resolved (status = Done) within [from, to] (inclusive,
// YYYY-MM-DD). Returns { byTicket, available, reason, fetched, window }. byTicket
// maps KEY → { sp, assignee, type, resolved, summary }. The whole window is
// re-fetched (not per-ticket TTL) because "which tickets closed in a range" can
// only be answered by the range query itself, not by looking up known keys.
async function fetchDeliveredTickets(rootDir, siteUrl, window, opts) {
  const options = opts || {};
  const timeoutMs = options.timeoutMs || HTTP_TIMEOUT_MS;
  const cacheTtlMs = options.cacheTtlMs != null ? options.cacheTtlMs : PERIOD_CACHE_TTL_MS;
  const { from, to } = window || {};
  if (!from || !to) {
    return { byTicket: {}, available: false, reason: 'bad-window', fetched: 0 };
  }
  const cache = loadPeriodCache(rootDir);
  const now = Date.now();
  const sameWindow = cache.window && cache.window.from === from && cache.window.to === to;
  const fresh = cache.generated_at && (now - new Date(cache.generated_at).getTime()) < cacheTtlMs;
  if (sameWindow && fresh && Object.keys(cache.entries).length >= 0 && cacheTtlMs > 0) {
    return { byTicket: cache.entries, available: true, reason: 'cache', fetched: 0, window: cache.window };
  }

  const auth = jiraAuthHeader();
  if (!auth) {
    // No creds: serve whatever cache exists (possibly for a different window).
    return {
      byTicket: cache.entries,
      available: Object.keys(cache.entries).length > 0,
      reason: 'no-credentials',
      fetched: 0,
      window: cache.window,
    };
  }
  if (!cache.cloud_id) {
    try { cache.cloud_id = await discoverCloudId(siteUrl, timeoutMs); }
    catch (err) { return { byTicket: cache.entries, available: false, reason: 'cloud-id-failed', error: err.message, fetched: 0 }; }
  }
  const cloudId = cache.cloud_id;
  if (!cache.detected_field) {
    try { cache.detected_field = await detectStoryPointField(cloudId, auth, timeoutMs); }
    catch (err) { return { byTicket: cache.entries, available: false, reason: 'field-detect-failed', error: err.message, fetched: 0 }; }
    if (!cache.detected_field) {
      return { byTicket: cache.entries, available: false, reason: 'no-sp-field', fetched: 0 };
    }
  }
  const spField = cache.detected_field;
  const project = jiraProject();
  if (!project) {
    return { byTicket: cache.entries, available: false, reason: 'no-jira-prefix', fetched: 0 };
  }
  const jql = `project = ${project} AND status = Done AND resolved >= "${from}" AND resolved <= "${to}" ORDER BY resolved DESC`;
  let issues;
  try {
    issues = await searchJql(cloudId, jql, [spField, 'assignee', 'issuetype', 'resolutiondate', 'summary'], auth, timeoutMs);
  } catch (err) {
    return { byTicket: cache.entries, available: Object.keys(cache.entries).length > 0, reason: 'search-failed', error: err.message, fetched: 0 };
  }
  const byTicket = {};
  for (const issue of issues) {
    const f = issue && issue.fields;
    if (!issue.key || !f) continue;
    const rawSp = f[spField];
    byTicket[issue.key] = {
      sp: rawSp == null ? 0 : Number(rawSp),
      assignee: (f.assignee && f.assignee.displayName) || null,
      type: (f.issuetype && f.issuetype.name) || null,
      resolved: f.resolutiondate ? String(f.resolutiondate).slice(0, 10) : null,
      summary: f.summary || '',
    };
  }
  cache.window = { from, to };
  cache.generated_at = new Date().toISOString();
  cache.entries = byTicket;
  savePeriodCache(rootDir, cache);
  return { byTicket, available: true, reason: 'ok', fetched: Object.keys(byTicket).length, window: cache.window };
}

module.exports = {
  fetchStoryPoints,
  loadSpCache,
  saveSpCache,
  spCachePath,
  jiraAuthHeader,
  SP_CACHE_TTL_MS,
  // Delivered-universe (AI-coverage) API:
  fetchDeliveredTickets,
  loadPeriodCache,
  periodCachePath,
  PERIOD_CACHE_TTL_MS,
};
