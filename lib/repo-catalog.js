const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CATALOG_FILE = path.join(ROOT, 'repo-catalog.json');

function loadRepoCatalog() {
    try {
        if (!fs.existsSync(CATALOG_FILE)) {
            return { repos: {}, lastUpdated: null };
        }
        return JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
    } catch (_) {
        return { repos: {}, lastUpdated: null };
    }
}

function saveRepoCatalog(catalog) {
    catalog.lastUpdated = new Date().toISOString();
    fs.writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 2));
}

/**
 * Log a repo check — records timestamp, status, skill count, and repo metadata.
 */
function logRepoCheck(catalog, repoName, info) {
    const now = new Date().toISOString();

    if (!catalog.repos[repoName]) {
        catalog.repos[repoName] = {
            firstSeen: now,
            lastChecked: now,
            checks: [],
            stars: info.stars || 0,
            forks: info.forks || 0,
            description: info.description || '',
            url: `https://github.com/${repoName}`,
            skillCount: info.skillCount || 0,
            skillIds: info.skillIds || [],
            status: info.status || 'checked',
        };
    } else {
        const entry = catalog.repos[repoName];
        entry.lastChecked = now;
        entry.stars = info.stars || entry.stars;
        entry.forks = info.forks || entry.forks;
        entry.description = info.description || entry.description;
        entry.skillCount = info.skillCount || entry.skillCount;
        if (info.skillIds && info.skillIds.length) {
            entry.skillIds = info.skillIds;
        }
        entry.status = info.status || 'checked';
    }

    // Keep last 20 check timestamps
    const checks = catalog.repos[repoName].checks;
    checks.push({
        timestamp: now,
        skillCount: info.skillCount || 0,
        status: info.status || 'checked',
    });
    if (checks.length > 20) {
        catalog.repos[repoName].checks = checks.slice(-20);
    }

    return catalog;
}

/**
 * Get repos that haven't been checked in a given number of hours.
 */
function getStaleRepos(catalog, maxAgeHours = 24) {
    const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();
    const stale = [];

    for (const [name, entry] of Object.entries(catalog.repos)) {
        if (entry.lastChecked < cutoff) {
            stale.push({ name, ...entry });
        }
    }

    return stale.sort((a, b) => a.lastChecked.localeCompare(b.lastChecked));
}

/**
 * Get summary stats for the repo catalog.
 */
function getCatalogStats(catalog) {
    const repos = Object.entries(catalog.repos);
    const total = repos.length;
    const totalSkills = repos.reduce((sum, [, entry]) => sum + (entry.skillCount || 0), 0);
    const withSkills = repos.filter(([, entry]) => (entry.skillCount || 0) > 0).length;
    const empty = repos.filter(([, entry]) => (entry.skillCount || 0) === 0).length;

    let oldestCheck = null;
    let newestCheck = null;
    for (const [, entry] of repos) {
        if (!oldestCheck || entry.lastChecked < oldestCheck) oldestCheck = entry.lastChecked;
        if (!newestCheck || entry.lastChecked > newestCheck) newestCheck = entry.lastChecked;
    }

    return {
        totalRepos: total,
        reposWithSkills: withSkills,
        emptyRepos: empty,
        totalSkills,
        oldestCheck,
        newestCheck,
        lastUpdated: catalog.lastUpdated,
    };
}

module.exports = {
    loadRepoCatalog,
    saveRepoCatalog,
    logRepoCheck,
    getStaleRepos,
    getCatalogStats,
    CATALOG_FILE,
};
