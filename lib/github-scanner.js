const https = require('https');
const { parseFrontmatter } = require('./skill-utils');
const { loadRepoCatalog, saveRepoCatalog, logRepoCheck } = require('./repo-catalog');

const GITHUB_API = 'api.github.com';
const USER_AGENT = 'antigravity-skills-consolidator';

// Well-known repos that contain SKILL.md-format agent skills
const KNOWN_SKILL_REPOS = [
    'wshobson/agents',
    'rmyndharis/antigravity-skills',
];

// Queries to rotate through during slow walk
const REPO_SEARCH_QUERIES = [
    'agent skills SKILL.md',
    'ai agent skills topic:ai',
    'claude code agents skills',
    'coding agent skills SKILL',
    'ai coding assistant skills',
    'llm agent tools skills',
    'gemini agent skills',
    'ai assistant workflow skills',
    'developer agent automation skills',
    'code agent prompt skills',
];

function getHeaders() {
    const headers = {
        'User-Agent': USER_AGENT,
        Accept: 'application/vnd.github.v3+json',
    };
    const token = process.env.GITHUB_TOKEN;
    if (token) {
        headers.Authorization = `token ${token}`;
    }
    return headers;
}

function hasToken() {
    return Boolean(process.env.GITHUB_TOKEN);
}

function httpsGet(url, headers) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const options = {
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: { ...headers, Host: parsed.hostname },
        };

        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                const rateLimitRemaining = parseInt(res.headers['x-ratelimit-remaining'] || '999', 10);
                const rateLimitReset = parseInt(res.headers['x-ratelimit-reset'] || '0', 10);
                resolve({
                    statusCode: res.statusCode,
                    body,
                    rateLimitRemaining,
                    rateLimitReset,
                });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestamp() {
    return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z/, 'Z');
}

function log(msg) {
    process.stderr.write(`[${timestamp()}] ${msg}\n`);
}

async function rateLimitedGet(url, headers, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        const result = await httpsGet(url, headers);

        if (result.statusCode === 403 && result.rateLimitRemaining === 0) {
            const resetTime = result.rateLimitReset * 1000;
            const waitMs = Math.max(resetTime - Date.now(), 1000);
            const waitSec = Math.ceil(waitMs / 1000);
            if (attempt < retries) {
                log(`⏳ Rate limited. Waiting ${waitSec}s...`);
                await sleep(waitMs);
                continue;
            }
            throw new Error(`GitHub API rate limit exceeded. Resets in ${waitSec}s. Set GITHUB_TOKEN for higher limits.`);
        }

        if (result.statusCode === 422) {
            return { statusCode: 422, body: '{"items":[]}', rateLimitRemaining: result.rateLimitRemaining };
        }

        if (result.statusCode >= 500 && attempt < retries) {
            log(`⚠️  Server error (${result.statusCode}), retrying in ${2 * (attempt + 1)}s...`);
            await sleep(2000 * (attempt + 1));
            continue;
        }

        // Log remaining rate limit when getting low
        if (result.rateLimitRemaining < 10) {
            log(`⚠️  Rate limit remaining: ${result.rateLimitRemaining}`);
        }

        return result;
    }
}

/**
 * Search GitHub repos by topic/keyword (works WITHOUT auth).
 */
async function searchRepos(query, page = 1, perPage = 30) {
    const headers = getHeaders();
    const encoded = encodeURIComponent(query);
    const url = `https://${GITHUB_API}/search/repositories?q=${encoded}&sort=stars&order=desc&per_page=${perPage}&page=${page}`;

    const result = await rateLimitedGet(url, headers);

    if (result.statusCode !== 200) {
        let message = `GitHub Repository Search API returned ${result.statusCode}`;
        try {
            const parsed = JSON.parse(result.body);
            if (parsed.message) message += `: ${parsed.message}`;
        } catch (_) { /* ignore */ }
        throw new Error(message);
    }

    const data = JSON.parse(result.body);
    return {
        totalCount: data.total_count || 0,
        items: (data.items || []).map((item) => ({
            repo: item.full_name,
            repoUrl: item.html_url,
            stars: item.stargazers_count || 0,
            forks: item.forks_count || 0,
            pushedAt: item.pushed_at || null,
            description: item.description || '',
            defaultBranch: item.default_branch || 'main',
        })),
    };
}

/**
 * Search GitHub code (REQUIRES auth token).
 */
async function searchCode(query, page = 1, perPage = 30) {
    const headers = getHeaders();
    const encoded = encodeURIComponent(query);
    const url = `https://${GITHUB_API}/search/code?q=${encoded}&per_page=${perPage}&page=${page}`;

    const result = await rateLimitedGet(url, headers);

    if (result.statusCode !== 200) {
        let message = `GitHub Code Search API returned ${result.statusCode}`;
        try {
            const parsed = JSON.parse(result.body);
            if (parsed.message) message += `: ${parsed.message}`;
        } catch (_) { /* ignore */ }
        throw new Error(message);
    }

    const data = JSON.parse(result.body);
    return {
        totalCount: data.total_count || 0,
        items: (data.items || []).map((item) => ({
            repo: item.repository.full_name,
            repoUrl: item.repository.html_url,
            path: item.path,
            name: item.name,
            htmlUrl: item.html_url,
        })),
    };
}

/**
 * Use the Git Tree API to list all SKILL.md files in a repo (works without auth).
 */
async function listSkillFiles(owner, repo, branch) {
    const headers = getHeaders();
    const url = `https://${GITHUB_API}/repos/${owner}/${repo}/git/trees/${branch || 'main'}?recursive=1`;

    const result = await rateLimitedGet(url, headers);

    if (result.statusCode !== 200) {
        if (branch !== 'master') {
            return listSkillFiles(owner, repo, 'master');
        }
        return [];
    }

    const data = JSON.parse(result.body);
    const tree = data.tree || [];

    return tree
        .filter((node) => node.type === 'blob' && node.path.endsWith('SKILL.md'))
        .map((node) => ({
            path: node.path,
            name: 'SKILL.md',
        }));
}

async function fetchFileContent(owner, repo, filePath) {
    const headers = getHeaders();
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const url = `https://${GITHUB_API}/repos/${owner}/${repo}/contents/${encodedPath}`;

    const result = await rateLimitedGet(url, headers);

    if (result.statusCode !== 200) {
        return null;
    }

    const data = JSON.parse(result.body);
    if (!data.content) return null;

    return Buffer.from(data.content, 'base64').toString('utf8');
}

async function fetchRepoInfo(owner, repo) {
    const headers = getHeaders();
    const url = `https://${GITHUB_API}/repos/${owner}/${repo}`;

    const result = await rateLimitedGet(url, headers);

    if (result.statusCode !== 200) {
        return { stars: 0, forks: 0, pushedAt: null, description: '', defaultBranch: 'main' };
    }

    const data = JSON.parse(result.body);
    return {
        stars: data.stargazers_count || 0,
        forks: data.forks_count || 0,
        pushedAt: data.pushed_at || null,
        description: data.description || '',
        defaultBranch: data.default_branch || 'main',
    };
}

/**
 * Check if we've exceeded the time budget.
 */
function isTimeUp(startTime, durationMs) {
    if (!durationMs) return false;
    return Date.now() - startTime >= durationMs;
}

/**
 * Calculate optimal delay between requests based on rate limits.
 * Unauthenticated: 10 search requests/min, 60 other requests/min
 * Authenticated: 30 search requests/min, 5000 other requests/hr
 */
function getDelay(isSearch) {
    if (hasToken()) {
        return isSearch ? 2200 : 800;
    }
    return isSearch ? 6500 : 2000;
}

/**
 * Scan a single repo: get info, list SKILL.md files, log to catalog.
 * Returns { repoInfo, skillFiles } or null if repo has no skills.
 */
async function scanSingleRepo(repoName, catalog) {
    const [owner, repo] = repoName.split('/');

    log(`📂 Checking repo: ${repoName}`);
    const repoInfo = await fetchRepoInfo(owner, repo);
    await sleep(getDelay(false));

    log(`   ★${repoInfo.stars} | ${repoInfo.forks} forks | last push: ${repoInfo.pushedAt || 'unknown'}`);

    const skillFiles = await listSkillFiles(owner, repo, repoInfo.defaultBranch);
    await sleep(getDelay(false));

    const skillIds = skillFiles.map((f) => {
        const parts = f.path.split('/');
        return parts.length > 1 ? parts[parts.length - 2] : f.path.replace('/SKILL.md', '');
    });

    logRepoCheck(catalog, repoName, {
        stars: repoInfo.stars,
        forks: repoInfo.forks,
        description: repoInfo.description,
        skillCount: skillFiles.length,
        skillIds,
        status: skillFiles.length > 0 ? 'has-skills' : 'no-skills',
    });
    saveRepoCatalog(catalog);

    if (skillFiles.length > 0) {
        log(`   ✅ Found ${skillFiles.length} skill(s)`);
    } else {
        log(`   ⬜ No skills found`);
    }

    return { repoInfo, skillFiles };
}

/**
 * Search for skill repos with slow walk support.
 * options.durationMs — time budget in ms (e.g., 3600000 for 1 hour)
 * options.limit — max total skill files to collect
 * options.queries — custom search queries
 */
async function searchForSkillRepos(options = {}) {
    const maxResults = options.limit || 30;
    const durationMs = options.durationMs || 0;
    const startTime = Date.now();
    const catalog = loadRepoCatalog();
    const allItems = [];
    const checkedRepos = new Set();

    const slowWalk = durationMs > 0;
    if (slowWalk) {
        const hours = (durationMs / 3600000).toFixed(1);
        log(`🐢 Slow walk mode: scanning for up to ${hours} hour(s)`);
    }

    // ─── Phase 1: Known repos ───
    log('─── Phase 1: Known repos ───');
    for (const repoName of KNOWN_SKILL_REPOS) {
        if (isTimeUp(startTime, durationMs) || allItems.length >= maxResults) break;
        if (checkedRepos.has(repoName)) continue;
        checkedRepos.add(repoName);

        const { repoInfo, skillFiles } = await scanSingleRepo(repoName, catalog);

        for (const file of skillFiles) {
            if (allItems.length >= maxResults) break;
            allItems.push({
                repo: repoName,
                repoUrl: `https://github.com/${repoName}`,
                path: file.path,
                name: file.name,
                htmlUrl: `https://github.com/${repoName}/blob/${repoInfo.defaultBranch}/${file.path}`,
            });
        }
    }

    // ─── Phase 2: Repo search (no auth required) ───
    log('─── Phase 2: Repository search ───');
    const searchQueries = options.queries && options.queries.length
        ? options.queries
        : REPO_SEARCH_QUERIES;

    let queryIndex = 0;
    let pageIndex = 1;

    while (!isTimeUp(startTime, durationMs) && allItems.length < maxResults) {
        if (queryIndex >= searchQueries.length) {
            if (!slowWalk) break;
            // In slow walk, cycle back and try deeper pages
            queryIndex = 0;
            pageIndex++;
            if (pageIndex > 5) {
                log('📋 Exhausted search pages — pausing before next cycle...');
                await sleep(60000); // Wait 1 minute before cycling
                pageIndex = 1;
            }
        }

        const query = searchQueries[queryIndex];
        queryIndex++;

        try {
            log(`🔍 Search: "${query}" (page ${pageIndex})`);
            const result = await searchRepos(query, pageIndex, 10);
            await sleep(getDelay(true));

            if (!result.items.length) {
                log(`   No results for this query/page`);
                continue;
            }

            for (const repoItem of result.items) {
                if (isTimeUp(startTime, durationMs) || allItems.length >= maxResults) break;
                if (checkedRepos.has(repoItem.repo)) continue;
                checkedRepos.add(repoItem.repo);

                const { repoInfo, skillFiles } = await scanSingleRepo(repoItem.repo, catalog);

                for (const file of skillFiles) {
                    if (allItems.length >= maxResults) break;
                    allItems.push({
                        repo: repoItem.repo,
                        repoUrl: repoItem.repoUrl,
                        path: file.path,
                        name: file.name,
                        htmlUrl: `https://github.com/${repoItem.repo}/blob/${repoInfo.defaultBranch}/${file.path}`,
                    });
                }
            }
        } catch (err) {
            log(`⚠️  Search "${query}" failed: ${err.message}`);
            if (slowWalk) {
                log('   Cooling down for 30s...');
                await sleep(30000);
            }
        }
    }

    // ─── Phase 3: Code search (requires token) ───
    if (hasToken() && allItems.length < maxResults && !isTimeUp(startTime, durationMs)) {
        log('─── Phase 3: Code search (authenticated) ───');
        const codeQueries = [
            'filename:SKILL.md path:skills',
            'filename:SKILL.md "description:"',
        ];
        for (const query of codeQueries) {
            if (allItems.length >= maxResults || isTimeUp(startTime, durationMs)) break;
            try {
                log(`🔍 Code search: "${query}"`);
                const result = await searchCode(query, 1, Math.min(maxResults - allItems.length, 30));
                await sleep(getDelay(true));

                for (const item of result.items) {
                    const key = `${item.repo}:${item.path}`;
                    if (!allItems.some((existing) => `${existing.repo}:${existing.path}` === key)) {
                        allItems.push(item);

                        // Log repo if new
                        if (!checkedRepos.has(item.repo)) {
                            checkedRepos.add(item.repo);
                            const [owner, repo] = item.repo.split('/');
                            const repoInfo = await fetchRepoInfo(owner, repo);
                            await sleep(getDelay(false));
                            logRepoCheck(catalog, item.repo, {
                                stars: repoInfo.stars,
                                forks: repoInfo.forks,
                                description: repoInfo.description,
                                skillCount: 1,
                                status: 'has-skills',
                            });
                            saveRepoCatalog(catalog);
                        }
                    }
                }
            } catch (err) {
                log(`⚠️  Code search "${query}" failed: ${err.message}`);
            }
        }
    }

    // ─── Summary ───
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    log(`─── Done ───`);
    log(`Checked ${checkedRepos.size} repos in ${elapsed}s, found ${allItems.length} skill files`);
    log(`Repo catalog: ${Object.keys(catalog.repos).length} total repos tracked`);

    return allItems.slice(0, maxResults);
}

async function discoverSkills(options = {}) {
    const searchResults = await searchForSkillRepos(options);
    const catalog = loadRepoCatalog();

    // Group by repo
    const repoMap = new Map();
    for (const item of searchResults) {
        if (!repoMap.has(item.repo)) {
            repoMap.set(item.repo, []);
        }
        repoMap.get(item.repo).push(item);
    }

    const discovered = [];
    const repoInfoCache = new Map();

    for (const [repoFullName, items] of repoMap) {
        const [owner, repo] = repoFullName.split('/');

        if (!repoInfoCache.has(repoFullName)) {
            repoInfoCache.set(repoFullName, await fetchRepoInfo(owner, repo));
            await sleep(getDelay(false));
        }
        const repoInfo = repoInfoCache.get(repoFullName);

        for (const item of items) {
            log(`📄 Fetching: ${item.repo}/${item.path}`);
            const content = await fetchFileContent(owner, repo, item.path);
            if (!content) {
                log(`   ⚠️  Failed to fetch content`);
                continue;
            }

            await sleep(getDelay(false));

            const { data, body, errors } = parseFrontmatter(content);

            const pathParts = item.path.split('/');
            const skillDir = pathParts.length > 1 ? pathParts[pathParts.length - 2] : pathParts[0].replace('.md', '');

            discovered.push({
                id: skillDir,
                name: typeof data.name === 'string' ? data.name.trim() : skillDir,
                description: typeof data.description === 'string' ? data.description.trim() : '',
                tags: Array.isArray(data.tags)
                    ? data.tags.map((tag) => String(tag).trim()).filter(Boolean)
                    : [],
                content: body || '',
                source: {
                    repo: repoFullName,
                    url: item.htmlUrl || `https://github.com/${repoFullName}`,
                    stars: repoInfo.stars,
                    forks: repoInfo.forks,
                    pushedAt: repoInfo.pushedAt,
                    path: item.path,
                },
                parseErrors: errors || [],
            });

            log(`   ✅ ${skillDir}: ${(data.description || '').slice(0, 60)}...`);
        }
    }

    return {
        reposScanned: repoMap.size,
        skills: discovered,
    };
}

module.exports = {
    searchForSkillRepos,
    searchRepos,
    fetchFileContent,
    fetchRepoInfo,
    listSkillFiles,
    discoverSkills,
    searchCode,
    hasToken,
    log,
    timestamp,
};
