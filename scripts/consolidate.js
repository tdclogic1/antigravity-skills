const fs = require('fs');
const path = require('path');
const { discoverSkills, log } = require('../lib/github-scanner');
const { rankAll } = require('../lib/skill-ranker');
const { loadRepoCatalog, getCatalogStats } = require('../lib/repo-catalog');

const ROOT = path.resolve(__dirname, '..');
const CATALOG_PATH = path.join(ROOT, 'catalog.json');

function loadExistingCatalog() {
    try {
        if (!fs.existsSync(CATALOG_PATH)) return [];
        const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
        return catalog.skills || [];
    } catch (_) {
        return [];
    }
}

function truncate(value, limit) {
    if (!value || value.length <= limit) return value || '';
    return `${value.slice(0, limit - 3)}...`;
}

/**
 * Parse a duration string like "1h", "30m", "3h", "90m" into milliseconds.
 */
function parseDuration(value) {
    if (!value) return 0;
    const match = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)$/i);
    if (!match) {
        const asNum = parseFloat(value);
        if (!isNaN(asNum) && asNum > 0) return asNum * 60 * 1000; // default to minutes
        return 0;
    }
    const num = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    if (unit.startsWith('h')) return num * 60 * 60 * 1000;
    return num * 60 * 1000;
}

function renderDiscoveredMarkdown(inventory) {
    const lines = [];
    lines.push('# Discovered Skills Report');
    lines.push('');
    lines.push(`Scanned at: ${inventory.scannedAt}`);
    lines.push(`Query: \`${inventory.query}\``);
    lines.push(`Repos scanned: ${inventory.reposScanned}`);
    lines.push(`Total discovered: ${inventory.totalDiscovered}`);
    if (inventory.duration) {
        lines.push(`Scan duration: ${inventory.duration}`);
    }
    lines.push('');

    // Group by tier
    const tiers = ['★★★', '★★', '★', '⬡'];
    const tierLabels = {
        '★★★': '★★★ Excellent (75+)',
        '★★': '★★ Good (50–74)',
        '★': '★ Fair (25–49)',
        '⬡': '⬡ Low (<25)',
    };

    for (const tier of tiers) {
        const tierSkills = inventory.skills.filter((s) => s.tier === tier);
        if (!tierSkills.length) continue;

        lines.push(`## ${tierLabels[tier]} — ${tierSkills.length} skills`);
        lines.push('');
        lines.push('| Score | Skill | Category | Description | Source | Duplicate? |');
        lines.push('| :---: | --- | --- | --- | --- | :---: |');

        for (const skill of tierSkills) {
            const desc = truncate(skill.description, 120).replace(/\|/g, '\\|');
            const source = `[${skill.source.repo}](${skill.source.url})`;
            const dup = skill.isDuplicate ? `⚠️ ${skill.duplicateOf}` : '✅ Unique';
            lines.push(`| ${skill.score} | \`${skill.id}\` | ${skill.category} | ${desc} | ${source} | ${dup} |`);
        }

        lines.push('');
    }

    // Category summary
    const categoryCounts = new Map();
    for (const skill of inventory.skills) {
        categoryCounts.set(skill.category, (categoryCounts.get(skill.category) || 0) + 1);
    }

    lines.push('## Category Summary');
    lines.push('');
    const sorted = Array.from(categoryCounts.entries()).sort((a, b) => b[1] - a[1]);
    for (const [category, count] of sorted) {
        lines.push(`- **${category}**: ${count} skills`);
    }
    lines.push('');

    return lines.join('\n');
}

async function consolidate(options = {}) {
    const query = options.query || 'filename:SKILL.md path:skills';
    const limit = options.limit || 20;
    const minScore = options.minScore || 0;
    const outputDir = options.output || ROOT;
    const durationMs = options.durationMs || 0;

    const durationLabel = durationMs
        ? `${(durationMs / 3600000).toFixed(1)} hour(s)`
        : 'single pass';

    log(`Starting consolidation (limit: ${limit}, duration: ${durationLabel})`);

    const existingSkills = loadExistingCatalog();
    log(`Loaded ${existingSkills.length} existing skills for deduplication.`);

    const { reposScanned, skills: discovered } = await discoverSkills({
        queries: [query],
        limit,
        durationMs,
    });

    log(`Discovered ${discovered.length} skills from ${reposScanned} repos.`);

    if (!discovered.length) {
        log('No skills discovered. Try a different search query or set GITHUB_TOKEN.');
        // Still show repo catalog stats
        const repoCatalog = loadRepoCatalog();
        const stats = getCatalogStats(repoCatalog);
        log(`Repo catalog: ${stats.totalRepos} repos tracked, ${stats.reposWithSkills} with skills.`);
        return null;
    }

    log('Ranking and categorizing...');
    let ranked = rankAll(discovered, existingSkills);

    if (minScore > 0) {
        ranked = ranked.filter((s) => s.score >= minScore);
        log(`Filtered to ${ranked.length} skills with score >= ${minScore}.`);
    }

    const inventory = {
        scannedAt: new Date().toISOString(),
        query,
        reposScanned,
        totalDiscovered: ranked.length,
        duration: durationLabel,
        skills: ranked,
    };

    const jsonPath = path.join(outputDir, 'discovered-skills.json');
    const mdPath = path.join(outputDir, 'DISCOVERED.md');

    fs.writeFileSync(jsonPath, JSON.stringify(inventory, null, 2));
    fs.writeFileSync(mdPath, renderDiscoveredMarkdown(inventory));

    log(`Output: ${jsonPath}`);
    log(`Output: ${mdPath}`);

    // Show repo catalog stats
    const repoCatalog = loadRepoCatalog();
    const stats = getCatalogStats(repoCatalog);
    log(`Repo catalog: ${stats.totalRepos} repos tracked total, ${stats.reposWithSkills} with skills, ${stats.totalSkills} skill files known.`);

    return inventory;
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const options = {};

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--query' && args[i + 1]) { options.query = args[++i]; }
        if (args[i] === '--limit' && args[i + 1]) { options.limit = parseInt(args[++i], 10); }
        if (args[i] === '--min-score' && args[i + 1]) { options.minScore = parseInt(args[++i], 10); }
        if (args[i] === '--output' && args[i + 1]) { options.output = path.resolve(args[++i]); }
        if (args[i] === '--duration' && args[i + 1]) { options.durationMs = parseDuration(args[++i]); }
    }

    consolidate(options)
        .then((inventory) => {
            if (inventory) {
                process.stdout.write(`\nConsolidation complete. ${inventory.totalDiscovered} skills inventoried.\n`);
            }
        })
        .catch((err) => {
            process.stderr.write(`Consolidation failed: ${err.message}\n`);
            process.exit(1);
        });
}

module.exports = { consolidate, parseDuration };
