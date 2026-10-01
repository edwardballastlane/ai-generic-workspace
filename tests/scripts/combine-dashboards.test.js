'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'combine-dashboards.js');

// Minimal stand-ins for the three real dashboards. Token and roadmap both
// declare a top-level `function render()` — the exact collision that broke the
// token filters on the combined page — and roadmap + self use inline onclick
// handlers that need global fns. The self dashboard loads Plotly from its
// <head> AND embeds its data as an inline <head> script (window.DASHBOARD_DATA)
// — both dropped by extractBody — so the combine must re-inject head scripts.
const SELF_HTML = [
  '<!DOCTYPE html><html><head><title>Self</title>',
  '<script src="https://cdn.plot.ly/plotly-2.27.0.min.js"></script>',
  '<script>window.DASHBOARD_DATA = {"ok":true,"rules":[]};/*SELF_DATA*/</script>',
  '<style>body{background:#000}.tab-btn{color:green}</style></head><body>',
  '<button class="tab-btn" onclick="switchTab(\'overview\')">Overview</button>',
  '<div class="tab-content active" id="tab-overview"></div>',
  '<script>function switchTab(){}function fmt(){}/*SELF_MARK*/document.addEventListener("DOMContentLoaded",function(){});</script>',
  '</body></html>',
].join('\n');

const TOKEN_HTML = [
  '<!DOCTYPE html><html><head><title>Tokens</title>',
  '<style>.card{color:red}</style></head><body>',
  '<div id="summary-cards"></div>',
  '<script>function render(){window.__TOKEN_RENDER__=true;}function fmt(){}/*TOKEN_MARK*/render();</script>',
  '</body></html>',
].join('\n');

const ROADMAP_HTML = [
  '<!DOCTYPE html><html><head><title>Roadmap</title>',
  '<style>.dev{color:blue}</style></head><body>',
  '<button onclick="selectView(null)">All</button>',
  '<script>function render(){window.__ROADMAP_RENDER__=true;}function selectView(){}/*ROADMAP_MARK*/render();</script>',
  '</body></html>',
].join('\n');

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'combine-'));
  const viz = path.join(dir, '.claude', 'visualizations');
  fs.mkdirSync(viz, { recursive: true });
  fs.writeFileSync(path.join(viz, 'dashboard.html'), SELF_HTML);
  fs.writeFileSync(path.join(viz, 'token-dashboard.html'), TOKEN_HTML);
  fs.writeFileSync(path.join(viz, 'roadmap.html'), ROADMAP_HTML);
  return { dir, viz };
}

function run(root) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, TOKEN_DASHBOARD_ROOT: root },
  });
}

// Return the <script> block (inner text) that contains `marker`.
function scriptContaining(html, marker) {
  const re = /<script>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1].includes(marker)) return m[1];
  }
  return null;
}

test('combine isolates the token script in an IIFE so the roadmap render cannot clobber it', async () => {
  const { dir, viz } = await setup();
  try {
    const r = run(dir);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    const html = fs.readFileSync(path.join(viz, 'index.html'), 'utf8');

    const tokenScript = scriptContaining(html, 'TOKEN_MARK');
    assert.ok(tokenScript, 'token script must be present in the combined output');
    assert.ok(/^\s*\(function\(\)\{/.test(tokenScript),
      'token script must be wrapped in an IIFE so its render() stays private');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('token dashboard is the default view; self-improvement is present and global for onclick', async () => {
  const { dir, viz } = await setup();
  try {
    const r = run(dir);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    const html = fs.readFileSync(path.join(viz, 'index.html'), 'utf8');

    // Three toggle buttons + three view containers.
    assert.ok(html.includes('id="btn-self"'), 'self toggle button must exist');
    assert.ok(html.includes('id="view-self"'), 'self view container must exist');

    // Token is the default: its button is active and the other views start hidden.
    assert.ok(/<button class="toggle-btn active" id="btn-token"/.test(html),
      'token button must be the active (default) toggle');
    assert.ok(/id="view-self" style="display:none"/.test(html),
      'self view must start hidden when token is default');
    assert.ok(/id="view-roadmap" style="display:none"/.test(html),
      'roadmap view must start hidden when token is default');
    // The token view itself must NOT carry an inline display:none.
    assert.ok(/id="view-token">/.test(html),
      'token view must be visible (no display:none) as the default');

    // Self has inline onclick (switchTab) → must NOT be IIFE-wrapped.
    const selfScript = scriptContaining(html, 'SELF_MARK');
    assert.ok(selfScript, 'self script must be present in the combined output');
    assert.ok(!/^\s*\(function\(\)\{/.test(selfScript),
      'self script must NOT be IIFE-wrapped — switchTab() must remain global for onclick');
    assert.ok(html.includes('onclick="switchTab(\'overview\')"'),
      'self inline onclick handler must survive the combine');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('self <head> scripts (Plotly CDN) are re-injected since extractBody drops <head>', async () => {
  const { dir, viz } = await setup();
  try {
    const r = run(dir);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    const html = fs.readFileSync(path.join(viz, 'index.html'), 'utf8');

    const plotlyTags = html.match(/<script[^>]*cdn\.plot\.ly[^>]*>/g) || [];
    assert.equal(plotlyTags.length, 1,
      'Plotly CDN script must be re-injected exactly once into the combined <head>');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('self inline <head> data script (window.DASHBOARD_DATA) is re-injected', async () => {
  // Regression: extractBody drops <head>, so the self dashboard's embedded
  // window.DASHBOARD_DATA was lost. In the deployed single-file build only
  // index.html is uploaded, so loadData()'s fetch('dashboard-data.json')
  // fallback returns the S3 index.html ("<!DOCTYPE...") and JSON.parse throws.
  // The inline head data script must survive into the combined output.
  const { dir, viz } = await setup();
  try {
    const r = run(dir);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    const html = fs.readFileSync(path.join(viz, 'index.html'), 'utf8');

    assert.ok(/SELF_DATA/.test(html),
      'self inline head data script must be present in the combined output');
    assert.ok(/window\.DASHBOARD_DATA\s*=/.test(html),
      'window.DASHBOARD_DATA assignment must survive so loadData() skips the fetch');
    const dataTags = html.match(/\/\*SELF_DATA\*\//g) || [];
    assert.equal(dataTags.length, 1, 'inline data script must be injected exactly once (deduped)');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('self CSS is scoped under #view-self so it cannot leak into other views', async () => {
  const { dir, viz } = await setup();
  try {
    const r = run(dir);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    const html = fs.readFileSync(path.join(viz, 'index.html'), 'utf8');

    assert.ok(html.includes('#view-self .tab-btn'),
      'self .tab-btn rule must be scoped under #view-self');
    // The bare `body{...}` rule must be rescoped to the container, not left global.
    assert.ok(!/(^|[\s{}])body\s*\{background:#000\}/.test(html),
      'self body rule must be rescoped, not applied to the whole combined page');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('roadmap script stays global so its inline onclick handlers keep resolving', async () => {
  const { dir, viz } = await setup();
  try {
    const r = run(dir);
    assert.equal(r.status, 0, `exit ${r.status}\nstderr=${r.stderr}`);
    const html = fs.readFileSync(path.join(viz, 'index.html'), 'utf8');

    const roadmapScript = scriptContaining(html, 'ROADMAP_MARK');
    assert.ok(roadmapScript, 'roadmap script must be present in the combined output');
    assert.ok(!/^\s*\(function\(\)\{/.test(roadmapScript),
      'roadmap script must NOT be IIFE-wrapped — selectView() must remain global for onclick');
    assert.ok(html.includes('onclick="selectView(null)"'),
      'roadmap inline onclick handler must survive the combine');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
