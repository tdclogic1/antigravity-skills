#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.env.PORT || '3848', 10);

function loadCatalog() {
    const catalogPath = path.join(ROOT, 'catalog.json');
    try {
        return JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    } catch (err) {
        return { skills: [], total: 0, generatedAt: null };
    }
}

function loadSkillContent(skillPath) {
    try {
        const fullPath = path.join(ROOT, skillPath);
        if (!fs.existsSync(fullPath)) return null;
        return fs.readFileSync(fullPath, 'utf8');
    } catch (_) {
        return null;
    }
}

function loadDiscovered() {
    const discPath = path.join(ROOT, 'discovered-skills.json');
    try {
        if (!fs.existsSync(discPath)) return null;
        return JSON.parse(fs.readFileSync(discPath, 'utf8'));
    } catch (_) {
        return null;
    }
}

function loadBundles() {
    const bundlePath = path.join(ROOT, 'bundles.json');
    try {
        return JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
    } catch (_) {
        return { bundles: {} };
    }
}

function json(res, data, status = 200) {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(data));
}

function handleAPI(req, res) {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === '/api/catalog') {
        return json(res, loadCatalog());
    }

    if (url.pathname === '/api/skill') {
        const id = url.searchParams.get('id');
        if (!id) return json(res, { error: 'Missing id' }, 400);
        const catalog = loadCatalog();
        const skill = catalog.skills.find((s) => s.id === id);
        if (!skill) return json(res, { error: 'Not found' }, 404);
        const content = loadSkillContent(skill.path);
        return json(res, { ...skill, content });
    }

    if (url.pathname === '/api/discovered') {
        const discovered = loadDiscovered();
        return json(res, discovered || { skills: [], totalDiscovered: 0 });
    }

    if (url.pathname === '/api/bundles') {
        return json(res, loadBundles());
    }

    if (url.pathname === '/api/stats') {
        const catalog = loadCatalog();
        const discovered = loadDiscovered();
        const categories = {};
        for (const skill of catalog.skills) {
            categories[skill.category] = (categories[skill.category] || 0) + 1;
        }
        return json(res, {
            total: catalog.total,
            generatedAt: catalog.generatedAt,
            categories,
            discoveredCount: discovered ? discovered.totalDiscovered : 0,
        });
    }

    json(res, { error: 'Not found' }, 404);
}

function getDashboardHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AG Skills Vault — All Skills</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #06080d;
  --surface: #0d1117;
  --surface-2: #161b22;
  --surface-3: #1c2333;
  --border: #21262d;
  --border-hover: #30363d;
  --text: #e6edf3;
  --text-secondary: #8b949e;
  --text-dim: #484f58;
  --accent: #58a6ff;
  --accent-subtle: rgba(88,166,255,0.1);
  --green: #3fb950;
  --green-subtle: rgba(63,185,80,0.1);
  --purple: #bc8cff;
  --purple-subtle: rgba(188,140,255,0.1);
  --yellow: #d29922;
  --yellow-subtle: rgba(210,153,34,0.1);
  --orange: #db6d28;
  --orange-subtle: rgba(219,109,40,0.1);
  --red: #f85149;
  --red-subtle: rgba(248,81,73,0.1);
  --pink: #db61a2;
  --pink-subtle: rgba(219,97,162,0.1);
  --radius: 10px;
  --radius-lg: 14px;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
}

/* ── Header ── */
.header {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 0 32px;
  position: sticky;
  top: 0;
  z-index: 100;
  backdrop-filter: blur(16px);
}
.header-inner {
  max-width: 1440px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 64px;
}
.header h1 {
  font-size: 18px;
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 10px;
  letter-spacing: -0.3px;
}
.header h1 .icon { font-size: 22px; }
.header .subtitle {
  font-size: 13px;
  color: var(--text-secondary);
  margin-left: 12px;
  font-weight: 400;
}
.search-wrap {
  position: relative;
  width: 360px;
}
.search-wrap .search-icon {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-dim);
  pointer-events: none;
  font-size: 14px;
}
.search-input {
  width: 100%;
  padding: 9px 14px 9px 36px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  font-family: inherit;
  font-size: 13px;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.search-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-subtle);
}
.search-input::placeholder { color: var(--text-dim); }

/* ── Stats Bar ── */
.stats-bar {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 0 32px;
}
.stats-bar-inner {
  max-width: 1440px;
  margin: 0 auto;
  display: flex;
  gap: 24px;
  padding: 12px 0;
  overflow-x: auto;
}
.stat-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-secondary);
  font-weight: 500;
}
.stat-chip .num {
  font-weight: 700;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}

/* ── Filters ── */
.filter-bar {
  max-width: 1440px;
  margin: 0 auto;
  padding: 20px 32px 0;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.filter-btn {
  padding: 6px 14px;
  border-radius: 20px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
  display: flex;
  align-items: center;
  gap: 5px;
}
.filter-btn:hover {
  border-color: var(--border-hover);
  color: var(--text);
  background: var(--surface-2);
}
.filter-btn.active {
  background: var(--accent-subtle);
  border-color: var(--accent);
  color: var(--accent);
}
.filter-btn .count {
  font-size: 10px;
  background: var(--surface-3);
  padding: 1px 6px;
  border-radius: 10px;
  font-variant-numeric: tabular-nums;
}
.filter-btn.active .count {
  background: rgba(88,166,255,0.2);
}

/* ── Category Colors ── */
.cat-security { --cat: #f85149; --cat-bg: rgba(248,81,73,0.08); }
.cat-infrastructure { --cat: #db6d28; --cat-bg: rgba(219,109,40,0.08); }
.cat-data-ai { --cat: #bc8cff; --cat-bg: rgba(188,140,255,0.08); }
.cat-development { --cat: #58a6ff; --cat-bg: rgba(88,166,255,0.08); }
.cat-general { --cat: #8b949e; --cat-bg: rgba(139,148,158,0.08); }
.cat-architecture { --cat: #3fb950; --cat-bg: rgba(63,185,80,0.08); }
.cat-business { --cat: #d29922; --cat-bg: rgba(210,153,34,0.08); }
.cat-testing { --cat: #db61a2; --cat-bg: rgba(219,97,162,0.08); }
.cat-workflow { --cat: #79c0ff; --cat-bg: rgba(121,192,255,0.08); }

/* ── Main Grid ── */
.main {
  max-width: 1440px;
  margin: 0 auto;
  padding: 20px 32px 60px;
}
.results-info {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.view-toggle {
  display: flex;
  gap: 4px;
}
.view-toggle button {
  width: 32px;
  height: 32px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}
.view-toggle button:hover { color: var(--text); background: var(--surface-2); }
.view-toggle button.active { background: var(--accent-subtle); border-color: var(--accent); color: var(--accent); }
.skill-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 14px;
}
.skill-grid.list-view {
  grid-template-columns: 1fr;
}

/* ── Skill Card ── */
.skill-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 20px;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  flex-direction: column;
  gap: 12px;
  position: relative;
  overflow: hidden;
}
.skill-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: var(--cat, var(--accent));
  opacity: 0;
  transition: opacity 0.2s;
}
.skill-card:hover {
  border-color: var(--border-hover);
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(0,0,0,0.3);
}
.skill-card:hover::before { opacity: 1; }
.skill-card .card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.skill-card .skill-name {
  font-size: 14px;
  font-weight: 700;
  letter-spacing: -0.2px;
  color: var(--text);
  line-height: 1.3;
  word-break: break-word;
}
.skill-card .cat-badge {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 12px;
  background: var(--cat-bg, var(--accent-subtle));
  color: var(--cat, var(--accent));
  text-transform: capitalize;
  white-space: nowrap;
}
.skill-card .description {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.55;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.skill-card .tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.skill-card .tag {
  font-size: 11px;
  color: var(--text-dim);
  background: var(--surface-2);
  padding: 2px 8px;
  border-radius: 6px;
  font-family: 'JetBrains Mono', monospace;
}

/* ── List View ── */
.list-view .skill-card {
  flex-direction: row;
  align-items: center;
  padding: 14px 20px;
  gap: 16px;
}
.list-view .skill-card .card-top { flex: 0 0 280px; }
.list-view .skill-card .description {
  flex: 1;
  -webkit-line-clamp: 2;
}
.list-view .skill-card .tags { flex: 0 0 auto; max-width: 250px; }

/* ── Detail Modal ── */
.modal-overlay {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.7);
  z-index: 200;
  backdrop-filter: blur(4px);
  align-items: flex-start;
  justify-content: center;
  padding: 60px 32px;
  overflow-y: auto;
}
.modal-overlay.open { display: flex; }
.modal {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  max-width: 800px;
  width: 100%;
  overflow: hidden;
  animation: slideUp 0.25s ease-out;
}
@keyframes slideUp {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
}
.modal-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 24px 28px;
  border-bottom: 1px solid var(--border);
  gap: 16px;
}
.modal-header h2 {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.3px;
}
.modal-header .close-btn {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 16px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}
.modal-header .close-btn:hover {
  background: var(--surface-2);
  color: var(--text);
}
.modal-body {
  padding: 24px 28px;
}
.modal-body .meta-row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}
.modal-body .meta-item {
  font-size: 12px;
  color: var(--text-secondary);
}
.modal-body .meta-item strong {
  color: var(--text);
  font-weight: 600;
}
.modal-body .full-desc {
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.65;
  margin-bottom: 20px;
}
.modal-body .skill-content {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-secondary);
  max-height: 400px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.modal-body .skill-content::-webkit-scrollbar { width: 6px; }
.modal-body .skill-content::-webkit-scrollbar-track { background: transparent; }
.modal-body .skill-content::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
.modal-body .tag-list {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.modal-body .tag-list .tag {
  font-size: 12px;
  color: var(--accent);
  background: var(--accent-subtle);
  padding: 4px 10px;
  border-radius: 8px;
  font-family: 'JetBrains Mono', monospace;
}
.modal-body h3 {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
}
.empty-state {
  text-align: center;
  padding: 80px 20px;
  color: var(--text-dim);
}
.empty-state .emote { font-size: 48px; margin-bottom: 16px; }
.empty-state h3 { font-size: 16px; color: var(--text-secondary); margin-bottom: 8px; text-transform: none; letter-spacing: normal; }

@media (max-width: 768px) {
  .header-inner { flex-direction: column; height: auto; padding: 12px 0; gap: 10px; }
  .search-wrap { width: 100%; }
  .filter-bar { padding: 12px 16px 0; }
  .main { padding: 16px; }
  .skill-grid { grid-template-columns: 1fr; }
  .list-view .skill-card { flex-direction: column; }
  .list-view .skill-card .card-top { flex: unset; }
  .modal-overlay { padding: 20px 12px; }
}
</style>
</head>
<body>

<div class="header">
  <div class="header-inner">
    <h1><span class="icon">⚡</span> AG Skills Vault <span class="subtitle" id="totalCount"></span></h1>
    <div class="search-wrap">
      <span class="search-icon">🔍</span>
      <input class="search-input" id="searchInput" type="text" placeholder="Search skills by name, description, or tag...">
    </div>
  </div>
</div>

<div class="stats-bar">
  <div class="stats-bar-inner" id="statsBar"></div>
</div>

<div class="filter-bar" id="filterBar"></div>

<div class="main">
  <div class="results-info">
    <span id="resultsInfo">Loading...</span>
    <div class="view-toggle">
      <button id="btnGrid" class="active" onclick="setView('grid')" title="Grid view">⊞</button>
      <button id="btnList" onclick="setView('list')" title="List view">☰</button>
    </div>
  </div>
  <div class="skill-grid" id="skillGrid"></div>
</div>

<div class="modal-overlay" id="modalOverlay" onclick="closeModal(event)">
  <div class="modal" onclick="event.stopPropagation()">
    <div class="modal-header">
      <div>
        <h2 id="modalTitle"></h2>
        <div id="modalMeta" class="meta-row"></div>
      </div>
      <button class="close-btn" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body" id="modalBody"></div>
  </div>
</div>

<script>
let allSkills = [];
let filteredSkills = [];
let activeCategory = null;
let currentView = 'grid';
let debounceTimer = null;

const CAT_ICONS = {
  security: '🛡️', infrastructure: '🏗️', 'data-ai': '🧠',
  development: '💻', general: '📦', architecture: '🏛️',
  business: '💼', testing: '🧪', workflow: '⚙️'
};

async function init() {
  const res = await fetch('/api/catalog');
  const catalog = await res.json();
  allSkills = catalog.skills || [];
  document.getElementById('totalCount').textContent = allSkills.length + ' skills';

  buildStats(catalog);
  buildFilters();
  applyFilters();

  document.getElementById('searchInput').addEventListener('input', (e) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => applyFilters(), 150);
  });
}

function buildStats(catalog) {
  const categories = {};
  for (const s of allSkills) categories[s.category] = (categories[s.category] || 0) + 1;
  const topCats = Object.entries(categories).sort((a,b) => b[1]-a[1]);

  const bar = document.getElementById('statsBar');
  bar.innerHTML =
    '<div class="stat-chip"><span class="num">' + allSkills.length + '</span> Total Skills</div>' +
    '<div class="stat-chip"><span class="num">' + topCats.length + '</span> Categories</div>' +
    '<div class="stat-chip"><span class="num">' + new Set(allSkills.flatMap(s => s.tags || [])).size + '</span> Unique Tags</div>' +
    (catalog.generatedAt ? '<div class="stat-chip">Updated: ' + new Date(catalog.generatedAt).toLocaleDateString() + '</div>' : '');
}

function buildFilters() {
  const categories = {};
  for (const s of allSkills) categories[s.category] = (categories[s.category] || 0) + 1;
  const sorted = Object.entries(categories).sort((a,b) => b[1]-a[1]);

  const bar = document.getElementById('filterBar');
  let html = '<button class="filter-btn active" onclick="filterCategory(null, this)">All <span class="count">' + allSkills.length + '</span></button>';
  for (const [cat, count] of sorted) {
    const icon = CAT_ICONS[cat] || '📂';
    html += '<button class="filter-btn cat-' + cat + '" onclick="filterCategory(\\'' + cat + '\\', this)">' +
      icon + ' ' + cat + ' <span class="count">' + count + '</span></button>';
  }
  bar.innerHTML = html;
}

function filterCategory(cat, btn) {
  activeCategory = cat;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  applyFilters();
}

function applyFilters() {
  const query = document.getElementById('searchInput').value.toLowerCase().trim();
  filteredSkills = allSkills.filter(s => {
    if (activeCategory && s.category !== activeCategory) return false;
    if (query) {
      const searchable = (s.id + ' ' + s.name + ' ' + s.description + ' ' + (s.tags || []).join(' ')).toLowerCase();
      return searchable.includes(query);
    }
    return true;
  });

  document.getElementById('resultsInfo').textContent =
    filteredSkills.length === allSkills.length
      ? 'Showing all ' + allSkills.length + ' skills'
      : 'Showing ' + filteredSkills.length + ' of ' + allSkills.length + ' skills';

  renderGrid();
}

function renderGrid() {
  const grid = document.getElementById('skillGrid');
  if (!filteredSkills.length) {
    grid.innerHTML = '<div class="empty-state"><div class="emote">🔍</div><h3>No skills match your search</h3><p>Try different keywords or clear filters</p></div>';
    return;
  }

  grid.innerHTML = filteredSkills.map(s => {
    const catClass = 'cat-' + s.category;
    const tags = (s.tags || []).slice(0, 4).map(t => '<span class="tag">' + esc(t) + '</span>').join('');
    return '<div class="skill-card ' + catClass + '" onclick="openSkill(\\'' + esc(s.id) + '\\')">' +
      '<div class="card-top">' +
        '<div class="skill-name">' + esc(s.id) + '</div>' +
        '<span class="cat-badge">' + (CAT_ICONS[s.category] || '') + ' ' + esc(s.category) + '</span>' +
      '</div>' +
      '<div class="description">' + esc(s.description || 'No description') + '</div>' +
      '<div class="tags">' + tags + '</div>' +
    '</div>';
  }).join('');
}

function setView(view) {
  currentView = view;
  const grid = document.getElementById('skillGrid');
  document.getElementById('btnGrid').classList.toggle('active', view === 'grid');
  document.getElementById('btnList').classList.toggle('active', view === 'list');
  grid.classList.toggle('list-view', view === 'list');
}

async function openSkill(id) {
  const res = await fetch('/api/skill?id=' + encodeURIComponent(id));
  const skill = await res.json();

  document.getElementById('modalTitle').textContent = skill.id;

  const catClass = 'cat-' + skill.category;
  document.getElementById('modalMeta').innerHTML =
    '<div class="meta-item"><strong>Category:</strong> ' + (CAT_ICONS[skill.category] || '') + ' ' + esc(skill.category) + '</div>' +
    '<div class="meta-item"><strong>Path:</strong> ' + esc(skill.path) + '</div>';

  let bodyHTML = '';

  // Description
  bodyHTML += '<div class="full-desc">' + esc(skill.description || 'No description available.') + '</div>';

  // Tags
  if (skill.tags && skill.tags.length) {
    bodyHTML += '<h3>Tags</h3>';
    bodyHTML += '<div class="tag-list">' + skill.tags.map(t => '<span class="tag">' + esc(t) + '</span>').join('') + '</div>';
  }

  // Full SKILL.md content
  if (skill.content) {
    bodyHTML += '<h3>SKILL.md Content</h3>';
    bodyHTML += '<div class="skill-content">' + esc(skill.content) + '</div>';
  }

  document.getElementById('modalBody').innerHTML = bodyHTML;
  document.getElementById('modalOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeModal(e) {
  if (e && e.target !== document.getElementById('modalOverlay') && !e.target.classList.contains('close-btn')) return;
  document.getElementById('modalOverlay').classList.remove('open');
  document.body.style.overflow = '';
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal({ target: document.getElementById('modalOverlay') });
});

function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(str));
  return d.innerHTML;
}

init();
</script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname.startsWith('/api/')) {
        return handleAPI(req, res);
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(getDashboardHTML());
});

server.listen(PORT, () => {
    console.log(`\n  \u26a1 AG Skills Vault Dashboard`);
    console.log(`  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);
    console.log(`  Local:  http://localhost:${PORT}`);
    console.log(`\n  Press Ctrl+C to stop\n`);
});

