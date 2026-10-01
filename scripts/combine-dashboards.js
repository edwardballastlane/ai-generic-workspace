'use strict';
/**
 * Combines the self-improvement dashboard (dashboard.html), the token
 * consumption dashboard (token-dashboard.html) and — when the workspace
 * generates one — a third `roadmap.html` view into a single self-contained
 * index.html with a toggle bar. The roadmap view is optional: without it the
 * combined page ships the two built-in views.
 *
 * Token Dashboard is the default view. The merged file is self-contained
 * (everything inlined) because the deploy step uploads only this one file
 * to S3 as index.html — sibling-file iframes would 404.
 *
 * Usage: node scripts/combine-dashboards.js
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.TOKEN_DASHBOARD_ROOT || path.join(__dirname, '..');
const VIZ = path.join(ROOT, '.claude', 'visualizations');
const SELF_FILE = path.join(VIZ, 'dashboard.html');
const TOKEN_FILE = path.join(VIZ, 'token-dashboard.html');
const ROADMAP_FILE = path.join(VIZ, 'roadmap.html');
const OUT_FILE = path.join(VIZ, 'index.html');

function extractBody(html) {
  const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return m ? m[1] : html;
}

// Both dashboards declare a top-level `function render()`. In the combined
// document the two scripts share one global scope, so the roadmap's render
// silently clobbers the token dashboard's `render(range, monthVal)` — the
// period/user filters then toggle their .active class but never re-render.
// Isolate the token script in an IIFE so its render/state stay private. Safe
// because the token dashboard uses addEventListener only (no inline on* handler
// depends on its globals); the roadmap keeps global scope for its inline
// onclick="selectView(...)" handlers. Matches the token dashboard's single
// attribute-less `<script>`; a `<script type=...>` would skip wrapping.
function wrapScriptsInIife(bodyHtml) {
  return bodyHtml.replace(/<script>([\s\S]*?)<\/script>/gi,
    (_, js) => '<script>(function(){\n' + js + '\n})();<\/script>');
}

/**
 * Extract <head> <script> tags — BOTH external `<script src=...>` (e.g. the
 * Plotly CDN) AND inline `<script>...</script>` blocks (e.g. the
 * self-improvement dashboard's `window.DASHBOARD_DATA = {...}` payload).
 *
 * extractBody() only keeps the <body>, so any head script is otherwise lost.
 * That matters in the DEPLOYED build: only index.html is uploaded to S3, so the
 * self dashboard's runtime `fetch('dashboard-data.json')` fallback returns the
 * S3 index.html ("<!DOCTYPE...") and JSON.parse throws. Re-injecting the inline
 * data script sets window.DASHBOARD_DATA, which loadData() returns before ever
 * fetching. De-duplicated by exact tag text.
 */
function extractHeadScripts(html) {
  const head = (html.match(/<head[^>]*>([\s\S]*?)<\/head>/i) || [, ''])[1];
  const tags = head.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
  return Array.from(new Set(tags));
}

/** Extract only the CSS text from <style> blocks — avoids leaking <title> or other text. */
function extractStyles(html) {
  const styles = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    styles.push(m[1]);
  }
  return styles.join('\n');
}

if (!fs.existsSync(SELF_FILE)) {
  process.stderr.write(`Missing: ${SELF_FILE}\nRun: npm run self:dashboard\n`);
  process.exit(1);
}
if (!fs.existsSync(TOKEN_FILE)) {
  process.stderr.write(`Missing: ${TOKEN_FILE}\nRun: npm run tokens:dashboard\n`);
  process.exit(1);
}
// Optional third view. Workspaces that generate a roadmap.html into
// .claude/visualizations/ get it as a third tab; everyone else gets two tabs.
const hasRoadmap = fs.existsSync(ROADMAP_FILE);

const selfHtml = fs.readFileSync(SELF_FILE, 'utf8');
const tokenHtml = fs.readFileSync(TOKEN_FILE, 'utf8');
const roadmapHtml = hasRoadmap ? fs.readFileSync(ROADMAP_FILE, 'utf8') : '';

const selfStyles = extractStyles(selfHtml);
const tokenStyles = extractStyles(tokenHtml);
const roadmapStyles = hasRoadmap ? extractStyles(roadmapHtml) : '';

// External head scripts (Plotly CDN etc.) from every source — extractBody drops <head>.
const headScripts = Array.from(new Set([
  ...extractHeadScripts(selfHtml),
  ...extractHeadScripts(tokenHtml),
  ...(hasRoadmap ? extractHeadScripts(roadmapHtml) : []),
])).join('\n');

// Token has no inline on* handlers, so its scripts are wrapped in an IIFE to keep
// its render()/fmt() private (they'd otherwise clobber the other dashboards' globals).
// The self-improvement and roadmap dashboards both rely on inline onclick handlers
// (switchTab/setRange/refresh and selectView/triggerRefresh respectively), so their
// scripts stay in global scope. This is safe: their global function names don't
// overlap, and their DOM element ids don't collide (verified before merging).
const selfBody = extractBody(selfHtml);
const tokenBody = wrapScriptsInIife(extractBody(tokenHtml));
const roadmapBody = hasRoadmap ? extractBody(roadmapHtml) : '';

// Scope every rule of a stylesheet under a container selector, so a view's CSS
// can't bleed into the other views on the combined page. Wrapping the whole
// block in `#view-x { ... }` would be invalid CSS, so each top-level selector
// is prefixed individually.
function scopeCSS(css, scope) {
  // Split into rules by tracking brace depth
  const result = [];
  let i = 0;
  const len = css.length;
  while (i < len) {
    // Skip whitespace
    while (i < len && /\s/.test(css[i])) { result.push(css[i]); i++; }
    if (i >= len) break;

    // At-rules (@keyframes, @media, etc.) — include as-is
    if (css[i] === '@') {
      let depth = 0;
      const start = i;
      // Find the end of the at-rule (either ; or matched {})
      while (i < len) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}') { depth--; if (depth <= 0) { i++; break; } }
        else if (css[i] === ';' && depth === 0) { i++; break; }
        i++;
      }
      result.push(css.slice(start, i));
      continue;
    }

    // Regular rule: read selector up to {, then block
    const selStart = i;
    while (i < len && css[i] !== '{') i++;
    if (i >= len) break;
    const selector = css.slice(selStart, i).trim();
    // Prefix each comma-separated selector part
    const prefixed = selector
      .split(',')
      .map(s => {
        const t = s.trim();
        if (!t) return t;
        // Don't double-scope rules that already reference the scope
        if (t.startsWith(scope)) return t;
        // body / html / :root — scope to the container instead
        if (/^(body|html|:root)(\s|$|,)/.test(t)) return `${scope} ${t.replace(/^(body|html|:root)/, '')}`.trim();
        return `${scope} ${t}`;
      })
      .join(', ');
    result.push(prefixed);

    // Copy block
    let depth = 0;
    while (i < len) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') { depth--; if (depth <= 0) { result.push(css[i]); i++; break; } }
      result.push(css[i]);
      i++;
    }
  }
  return result.join('');
}

const scopedSelf = scopeCSS(selfStyles, '#view-self');
const scopedRoadmap = hasRoadmap ? scopeCSS(roadmapStyles, '#view-roadmap') : '';

const combined = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lane Dashboard</title>

<!-- External head scripts (Plotly CDN etc.) pulled from the source dashboards -->
${headScripts}

<!-- Self-Improvement styles (scoped to #view-self) -->
<style id="self-styles">
${scopedSelf}
</style>

<!-- Token Dashboard styles (unscoped) -->
<style id="token-styles">
${tokenStyles}
</style>

${hasRoadmap ? `<!-- Roadmap styles (scoped to #view-roadmap to prevent CSS conflicts) -->
<style id="roadmap-styles">
${scopedRoadmap}
</style>` : ''}

<!-- Toggle bar -->
<style>
  #dash-toggle-bar {
    position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
    background: #0d1117; border-bottom: 1px solid #30363d;
    display: flex; align-items: center; padding: 6px 16px; gap: 8px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  #dash-toggle-bar span {
    font-size: 0.78rem; color: #8b949e;
  }
  .toggle-btn {
    background: #161b22; border: 1px solid #30363d; border-radius: 6px;
    color: #8b949e; font-size: 0.78rem; padding: 4px 12px; cursor: pointer;
    transition: all 0.15s;
  }
  .toggle-btn.active {
    background: #f97316; color: #000; border-color: #f97316; font-weight: 600;
  }
  .toggle-btn:hover:not(.active) { border-color: #f97316; color: #e6edf3; }
  #view-self, #view-token, #view-roadmap { padding-top: 44px; }
</style>
</head>
<body>

<div id="dash-toggle-bar">
  <span>Lane</span>
  <button class="toggle-btn active" id="btn-token" onclick="showView('token')">Token Dashboard</button>
  <button class="toggle-btn" id="btn-self" onclick="showView('self')">Self-Improvement</button>
${hasRoadmap ? `  <button class="toggle-btn" id="btn-roadmap" onclick="showView('roadmap')">Developer Roadmap</button>` : ''}
</div>

<div id="view-token">
${tokenBody}
</div>

<div id="view-self" style="display:none">
${selfBody}
</div>

${hasRoadmap ? `<div id="view-roadmap" style="display:none">
${roadmapBody}
</div>` : ''}

<script>
var DASH_VIEWS = ${JSON.stringify(hasRoadmap ? ['token', 'self', 'roadmap'] : ['token', 'self'])};
function showView(name) {
  if (!DASH_VIEWS.includes(name)) name = 'token';
  DASH_VIEWS.forEach(function(v) {
    // Use display:'block' not '' so the CSS stylesheet default doesn't re-hide it
    document.getElementById('view-' + v).style.display = v === name ? 'block' : 'none';
    document.getElementById('btn-' + v).classList.toggle('active', v === name);
  });
  localStorage.setItem('lane-dash-view', name);
}
// Restore last view (defaults to the token dashboard)
const saved = localStorage.getItem('lane-dash-view');
if (saved) showView(saved);
</script>
</body>
</html>`;

fs.writeFileSync(OUT_FILE, combined);
console.log(`Combined dashboard written to ${OUT_FILE} (${(combined.length / 1024).toFixed(0)} KB)`);
