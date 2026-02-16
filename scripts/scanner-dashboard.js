#!/usr/bin/env node

const http = require('http');
const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');
const { loadRepoCatalog, getCatalogStats } = require('../lib/repo-catalog');

const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.env.PORT || '3847', 10);

// ─── Scanner State ───
let scannerProcess = null;
let scannerStatus = 'idle'; // idle | running | stopping
let scannerLogs = [];
let scannerStartedAt = null;
let scannerConfig = { limit: 50, duration: '1h', query: 'filename:SKILL.md path:skills' };
const MAX_LOG_LINES = 500;

function addLog(line) {
    const entry = { ts: new Date().toISOString(), msg: line.replace(/\n$/, '') };
    scannerLogs.push(entry);
    if (scannerLogs.length > MAX_LOG_LINES) {
        scannerLogs = scannerLogs.slice(-MAX_LOG_LINES);
    }
}

function startScanner(config = {}) {
    if (scannerProcess) {
        return { ok: false, error: 'Scanner is already running' };
    }

    Object.assign(scannerConfig, config);
    scannerStatus = 'running';
    scannerStartedAt = new Date().toISOString();
    scannerLogs = [];
    addLog(`Scanner started with: limit=${scannerConfig.limit}, duration=${scannerConfig.duration}, query="${scannerConfig.query}"`);

    const args = [
        '--limit', String(scannerConfig.limit),
        '--duration', scannerConfig.duration,
        '--query', scannerConfig.query,
    ];

    scannerProcess = fork(path.join(__dirname, 'consolidate.js'), args, {
        cwd: ROOT,
        silent: true,
        env: { ...process.env },
    });

    scannerProcess.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        lines.forEach((line) => addLog(line));
    });

    scannerProcess.stderr.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        lines.forEach((line) => addLog(line));
    });

    scannerProcess.on('close', (code) => {
        addLog(`Scanner exited with code ${code}`);
        scannerStatus = 'idle';
        scannerProcess = null;
    });

    scannerProcess.on('error', (err) => {
        addLog(`Scanner error: ${err.message}`);
        scannerStatus = 'idle';
        scannerProcess = null;
    });

    return { ok: true };
}

function stopScanner() {
    if (!scannerProcess) {
        return { ok: false, error: 'Scanner is not running' };
    }

    scannerStatus = 'stopping';
    addLog('Stopping scanner...');
    scannerProcess.kill('SIGTERM');

    setTimeout(() => {
        if (scannerProcess) {
            scannerProcess.kill('SIGKILL');
            addLog('Force-killed scanner');
            scannerProcess = null;
            scannerStatus = 'idle';
        }
    }, 5000);

    return { ok: true };
}

function restartScanner(config = {}) {
    if (scannerProcess) {
        stopScanner();
        // Wait for process to die, then start
        const check = setInterval(() => {
            if (!scannerProcess) {
                clearInterval(check);
                startScanner(config);
            }
        }, 500);
        return { ok: true, restarting: true };
    }
    return startScanner(config);
}

function getStatus() {
    const catalog = loadRepoCatalog();
    const stats = getCatalogStats(catalog);

    let elapsed = null;
    if (scannerStartedAt && scannerStatus === 'running') {
        const ms = Date.now() - new Date(scannerStartedAt).getTime();
        const mins = Math.floor(ms / 60000);
        const secs = Math.floor((ms % 60000) / 1000);
        elapsed = `${mins}m ${secs}s`;
    }

    // Read discovered-skills.json if it exists
    let discoveredCount = 0;
    const discoveredPath = path.join(ROOT, 'discovered-skills.json');
    try {
        if (fs.existsSync(discoveredPath)) {
            const data = JSON.parse(fs.readFileSync(discoveredPath, 'utf8'));
            discoveredCount = data.totalDiscovered || 0;
        }
    } catch (_) { }

    return {
        status: scannerStatus,
        startedAt: scannerStartedAt,
        elapsed,
        config: scannerConfig,
        logCount: scannerLogs.length,
        catalog: stats,
        discoveredCount,
    };
}

// ─── HTTP Server ───
function parseBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString()));
            } catch (_) {
                resolve({});
            }
        });
    });
}

function json(res, data, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
}

async function handleAPI(req, res) {
    const url = req.url;

    if (url === '/api/status') {
        return json(res, getStatus());
    }

    if (url === '/api/logs') {
        const since = new URL(req.url, `http://localhost:${PORT}`).searchParams?.get('since');
        let logs = scannerLogs;
        if (since) {
            logs = logs.filter((l) => l.ts > since);
        }
        return json(res, { logs, total: scannerLogs.length });
    }

    if (url === '/api/repos') {
        const catalog = loadRepoCatalog();
        return json(res, catalog);
    }

    if (url === '/api/start' && req.method === 'POST') {
        const body = await parseBody(req);
        return json(res, startScanner(body));
    }

    if (url === '/api/stop' && req.method === 'POST') {
        return json(res, stopScanner());
    }

    if (url === '/api/restart' && req.method === 'POST') {
        const body = await parseBody(req);
        return json(res, restartScanner(body));
    }

    json(res, { error: 'Not found' }, 404);
}

// ─── Dashboard HTML ───
function getDashboardHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AG Skills Scanner Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0a0e17;
    --surface: #111827;
    --surface-2: #1a2332;
    --border: #1e2d3d;
    --text: #e2e8f0;
    --text-dim: #64748b;
    --accent: #3b82f6;
    --accent-glow: rgba(59,130,246,0.15);
    --green: #10b981;
    --green-glow: rgba(16,185,129,0.15);
    --red: #ef4444;
    --red-glow: rgba(239,68,68,0.12);
    --yellow: #f59e0b;
    --yellow-glow: rgba(245,158,11,0.12);
    --radius: 12px;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: 'Inter', system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    padding: 0;
  }

  .header {
    background: linear-gradient(135deg, var(--surface), var(--surface-2));
    border-bottom: 1px solid var(--border);
    padding: 20px 32px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    position: sticky;
    top: 0;
    z-index: 100;
    backdrop-filter: blur(12px);
  }

  .header h1 {
    font-size: 20px;
    font-weight: 700;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .header h1 span { font-size: 22px; }

  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    border-radius: 20px;
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .status-pill.idle { background: var(--surface-2); color: var(--text-dim); }
  .status-pill.running { background: var(--green-glow); color: var(--green); border: 1px solid rgba(16,185,129,0.3); }
  .status-pill.stopping { background: var(--yellow-glow); color: var(--yellow); border: 1px solid rgba(245,158,11,0.3); }

  .status-pill .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
  }

  .status-pill.running .dot {
    animation: pulse 1.5s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  .container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 24px 32px;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
  }

  .stat-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
    transition: border-color 0.2s;
  }

  .stat-card:hover { border-color: var(--accent); }

  .stat-card .label {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 8px;
  }

  .stat-card .value {
    font-size: 28px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .stat-card .sub {
    font-size: 12px;
    color: var(--text-dim);
    margin-top: 4px;
  }

  .controls {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 24px;
    margin-bottom: 24px;
  }

  .controls h2 {
    font-size: 15px;
    font-weight: 600;
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .form-row {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
    min-width: 150px;
  }

  .field label {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }

  .field input, .field select {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    color: var(--text);
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    outline: none;
    transition: border-color 0.2s;
  }

  .field input:focus, .field select:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-glow);
  }

  .btn-row {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }

  button {
    padding: 10px 20px;
    border-radius: 8px;
    border: none;
    font-family: 'Inter', sans-serif;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .btn-start {
    background: var(--green);
    color: #fff;
  }

  .btn-start:hover { background: #0d9668; transform: translateY(-1px); box-shadow: 0 4px 12px var(--green-glow); }
  .btn-start:disabled { opacity: 0.4; cursor: not-allowed; transform: none; box-shadow: none; }

  .btn-stop {
    background: var(--red);
    color: #fff;
  }

  .btn-stop:hover { background: #dc2626; }
  .btn-stop:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-restart {
    background: var(--accent);
    color: #fff;
  }

  .btn-restart:hover { background: #2563eb; transform: translateY(-1px); }

  .btn-clear {
    background: var(--surface-2);
    color: var(--text-dim);
    border: 1px solid var(--border);
  }

  .btn-clear:hover { color: var(--text); border-color: var(--text-dim); }

  .log-panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    margin-bottom: 24px;
  }

  .log-panel .log-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
  }

  .log-panel .log-header h2 {
    font-size: 15px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .log-badge {
    background: var(--accent-glow);
    color: var(--accent);
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 10px;
  }

  .log-body {
    height: 400px;
    overflow-y: auto;
    padding: 12px 16px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    line-height: 1.7;
    scroll-behavior: smooth;
  }

  .log-body::-webkit-scrollbar { width: 6px; }
  .log-body::-webkit-scrollbar-track { background: transparent; }
  .log-body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

  .log-line {
    display: flex;
    gap: 12px;
    padding: 2px 0;
  }

  .log-line .ts {
    color: var(--text-dim);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .log-line .msg { word-break: break-word; }
  .log-line .msg.has-emoji { }

  .log-line.phase { color: var(--accent); font-weight: 500; }
  .log-line.success { color: var(--green); }
  .log-line.warn { color: var(--yellow); }
  .log-line.error { color: var(--red); }

  .repo-panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .repo-panel .repo-header {
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .repo-panel .repo-header h2 {
    font-size: 15px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .repo-list {
    max-height: 400px;
    overflow-y: auto;
    padding: 8px 0;
  }

  .repo-item {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
    transition: background 0.15s;
  }

  .repo-item:last-child { border-bottom: none; }
  .repo-item:hover { background: var(--surface-2); }

  .repo-item .repo-name {
    font-weight: 600;
    font-size: 13px;
    color: var(--accent);
  }

  .repo-item .repo-name a {
    color: inherit;
    text-decoration: none;
  }

  .repo-item .repo-name a:hover { text-decoration: underline; }

  .repo-item .repo-meta {
    font-size: 12px;
    color: var(--text-dim);
    margin-top: 4px;
  }

  .repo-item .repo-skills {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .skill-count {
    background: var(--green-glow);
    color: var(--green);
    font-size: 12px;
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 8px;
  }

  .skill-count.zero {
    background: var(--surface-2);
    color: var(--text-dim);
  }

  .auto-scroll-toggle {
    font-size: 12px;
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-dim);
    cursor: pointer;
  }

  .auto-scroll-toggle input { accent-color: var(--accent); }

  @media (max-width: 768px) {
    .header { padding: 16px; }
    .container { padding: 16px; }
    .form-row { flex-direction: column; }
    .field { min-width: unset; }
  }
</style>
</head>
<body>

<div class="header">
  <h1><span>🔍</span> AG Skills Scanner</h1>
  <div id="statusPill" class="status-pill idle">
    <span class="dot"></span>
    <span id="statusText">Idle</span>
  </div>
</div>

<div class="container">
  <!-- Stats -->
  <div class="grid" id="statsGrid">
    <div class="stat-card">
      <div class="label">Status</div>
      <div class="value" id="statStatus">Idle</div>
      <div class="sub" id="statElapsed"></div>
    </div>
    <div class="stat-card">
      <div class="label">Repos Tracked</div>
      <div class="value" id="statRepos">0</div>
      <div class="sub" id="statReposWithSkills"></div>
    </div>
    <div class="stat-card">
      <div class="label">Skills Discovered</div>
      <div class="value" id="statSkills">0</div>
      <div class="sub" id="statLastUpdate"></div>
    </div>
    <div class="stat-card">
      <div class="label">Log Lines</div>
      <div class="value" id="statLogs">0</div>
      <div class="sub">Live stream</div>
    </div>
  </div>

  <!-- Controls -->
  <div class="controls">
    <h2>⚙️ Scanner Controls</h2>
    <div class="form-row">
      <div class="field">
        <label>Duration</label>
        <select id="inputDuration">
          <option value="30m">30 minutes</option>
          <option value="1h" selected>1 hour</option>
          <option value="2h">2 hours</option>
          <option value="3h">3 hours</option>
          <option value="6h">6 hours</option>
        </select>
      </div>
      <div class="field">
        <label>Max Skills</label>
        <input type="number" id="inputLimit" value="50" min="5" max="500">
      </div>
      <div class="field" style="flex: 3;">
        <label>Search Query</label>
        <input type="text" id="inputQuery" value="filename:SKILL.md path:skills">
      </div>
    </div>
    <div class="btn-row">
      <button class="btn-start" id="btnStart" onclick="doStart()">▶ Start Scanner</button>
      <button class="btn-stop" id="btnStop" onclick="doStop()" disabled>■ Stop</button>
      <button class="btn-restart" id="btnRestart" onclick="doRestart()">↻ Restart</button>
      <button class="btn-clear" onclick="doClearLogs()">Clear Logs</button>
    </div>
  </div>

  <!-- Logs -->
  <div class="log-panel">
    <div class="log-header">
      <h2>📋 Live Logs <span class="log-badge" id="logBadge">0</span></h2>
      <label class="auto-scroll-toggle">
        <input type="checkbox" id="autoScroll" checked> Auto-scroll
      </label>
    </div>
    <div class="log-body" id="logBody">
      <div style="color: var(--text-dim); font-style: italic;">Waiting for scanner output...</div>
    </div>
  </div>

  <!-- Repos -->
  <div class="repo-panel">
    <div class="repo-header">
      <h2>📂 Repo Catalog <span class="log-badge" id="repoBadge">0</span></h2>
    </div>
    <div class="repo-list" id="repoList">
      <div style="padding: 20px; color: var(--text-dim); text-align: center;">No repos cataloged yet</div>
    </div>
  </div>
</div>

<script>
const API = '';
let lastLogTs = '';
let autoScrollEnabled = true;

document.getElementById('autoScroll').addEventListener('change', (e) => {
  autoScrollEnabled = e.target.checked;
});

function classifyLine(msg) {
  if (msg.includes('───')) return 'phase';
  if (msg.includes('✅') || msg.includes('complete')) return 'success';
  if (msg.includes('⚠️') || msg.includes('Warning')) return 'warn';
  if (msg.includes('error') || msg.includes('failed') || msg.includes('❌')) return 'error';
  return '';
}

function formatTs(ts) {
  return ts.replace('T', ' ').replace(/\\.\\d+Z/, '').slice(11);
}

async function fetchStatus() {
  try {
    const res = await fetch(API + '/api/status');
    const data = await res.json();
    updateUI(data);
  } catch (_) {}
}

async function fetchLogs() {
  try {
    const url = lastLogTs ? API + '/api/logs?since=' + encodeURIComponent(lastLogTs) : API + '/api/logs';
    const res = await fetch(url);
    const data = await res.json();

    if (data.logs && data.logs.length > 0) {
      const body = document.getElementById('logBody');

      // Clear placeholder
      if (body.querySelector('[style]')) body.innerHTML = '';

      for (const log of data.logs) {
        const div = document.createElement('div');
        div.className = 'log-line ' + classifyLine(log.msg);
        div.innerHTML = '<span class="ts">' + formatTs(log.ts) + '</span><span class="msg">' + escapeHtml(log.msg) + '</span>';
        body.appendChild(div);
        lastLogTs = log.ts;
      }

      document.getElementById('logBadge').textContent = data.total;

      if (autoScrollEnabled) {
        body.scrollTop = body.scrollHeight;
      }
    }
  } catch (_) {}
}

async function fetchRepos() {
  try {
    const res = await fetch(API + '/api/repos');
    const data = await res.json();
    renderRepos(data);
  } catch (_) {}
}

function renderRepos(catalog) {
  const list = document.getElementById('repoList');
  const entries = Object.entries(catalog.repos || {});
  document.getElementById('repoBadge').textContent = entries.length;

  if (!entries.length) {
    list.innerHTML = '<div style="padding: 20px; color: var(--text-dim); text-align: center;">No repos cataloged yet</div>';
    return;
  }

  entries.sort((a, b) => (b[1].lastChecked || '').localeCompare(a[1].lastChecked || ''));

  list.innerHTML = entries.map(([name, entry]) => {
    const skillClass = entry.skillCount > 0 ? '' : 'zero';
    return '<div class="repo-item">' +
      '<div>' +
        '<div class="repo-name"><a href="' + entry.url + '" target="_blank">' + escapeHtml(name) + '</a></div>' +
        '<div class="repo-meta">★' + (entry.stars || 0) + ' · ' + (entry.forks || 0) + ' forks · Last checked: ' + formatTs(entry.lastChecked || '') + '</div>' +
      '</div>' +
      '<div class="repo-skills">' +
        '<span class="skill-count ' + skillClass + '">' + (entry.skillCount || 0) + ' skills</span>' +
      '</div>' +
    '</div>';
  }).join('');
}

function updateUI(data) {
  // Status pill
  const pill = document.getElementById('statusPill');
  pill.className = 'status-pill ' + data.status;
  document.getElementById('statusText').textContent = data.status.charAt(0).toUpperCase() + data.status.slice(1);

  // Stats
  document.getElementById('statStatus').textContent = data.status.charAt(0).toUpperCase() + data.status.slice(1);
  document.getElementById('statElapsed').textContent = data.elapsed ? 'Running for ' + data.elapsed : '';
  document.getElementById('statRepos').textContent = data.catalog.totalRepos || 0;
  document.getElementById('statReposWithSkills').textContent = (data.catalog.reposWithSkills || 0) + ' with skills';
  document.getElementById('statSkills').textContent = data.discoveredCount || 0;
  document.getElementById('statLastUpdate').textContent = data.catalog.lastUpdated ? 'Updated: ' + formatTs(data.catalog.lastUpdated) : '';
  document.getElementById('statLogs').textContent = data.logCount;

  // Buttons
  const isRunning = data.status === 'running' || data.status === 'stopping';
  document.getElementById('btnStart').disabled = isRunning;
  document.getElementById('btnStop').disabled = !isRunning;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

async function doStart() {
  const body = {
    duration: document.getElementById('inputDuration').value,
    limit: parseInt(document.getElementById('inputLimit').value, 10),
    query: document.getElementById('inputQuery').value,
  };
  await fetch(API + '/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  fetchStatus();
}

async function doStop() {
  await fetch(API + '/api/stop', { method: 'POST' });
  fetchStatus();
}

async function doRestart() {
  const body = {
    duration: document.getElementById('inputDuration').value,
    limit: parseInt(document.getElementById('inputLimit').value, 10),
    query: document.getElementById('inputQuery').value,
  };
  lastLogTs = '';
  document.getElementById('logBody').innerHTML = '';
  await fetch(API + '/api/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  fetchStatus();
}

function doClearLogs() {
  document.getElementById('logBody').innerHTML = '<div style="color: var(--text-dim); font-style: italic;">Logs cleared</div>';
  lastLogTs = new Date().toISOString();
}

// Polling
fetchStatus();
fetchLogs();
fetchRepos();
setInterval(fetchStatus, 3000);
setInterval(fetchLogs, 2000);
setInterval(fetchRepos, 10000);
</script>
</body>
</html>`;
}

// ─── Server ───
const server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
    }

    if (req.url.startsWith('/api/')) {
        return handleAPI(req, res);
    }

    // Serve dashboard
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(getDashboardHTML());
});

server.listen(PORT, () => {
    console.log(`\n  🔍 AG Skills Scanner Dashboard`);
    console.log(`  ────────────────────────────────`);
    console.log(`  Local:   http://localhost:${PORT}`);
    console.log(`  Status:  http://localhost:${PORT}/api/status`);
    console.log(`\n  Press Ctrl+C to stop\n`);
});
