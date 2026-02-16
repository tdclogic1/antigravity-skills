const { tokenize, unique } = require('./skill-utils');

// Reuse category rules from build-catalog
const CATEGORY_RULES = [
    {
        name: 'security',
        keywords: [
            'security', 'sast', 'compliance', 'privacy', 'threat', 'vulnerability', 'owasp', 'pci', 'gdpr',
            'secrets', 'risk', 'malware', 'forensics', 'attack', 'incident', 'auth', 'mtls', 'zero', 'trust',
        ],
    },
    {
        name: 'infrastructure',
        keywords: [
            'kubernetes', 'k8s', 'helm', 'terraform', 'cloud', 'network', 'devops', 'gitops', 'prometheus',
            'grafana', 'observability', 'monitoring', 'logging', 'tracing', 'deployment', 'istio', 'linkerd',
            'service', 'mesh', 'slo', 'sre', 'oncall', 'incident', 'pipeline', 'cicd', 'ci', 'cd', 'kafka',
        ],
    },
    {
        name: 'data-ai',
        keywords: [
            'data', 'database', 'db', 'sql', 'postgres', 'mysql', 'analytics', 'etl', 'warehouse', 'dbt',
            'ml', 'ai', 'llm', 'rag', 'vector', 'embedding', 'spark', 'airflow', 'cdc', 'pipeline',
        ],
    },
    {
        name: 'development',
        keywords: [
            'python', 'javascript', 'typescript', 'java', 'golang', 'go', 'rust', 'csharp', 'dotnet', 'php',
            'ruby', 'node', 'react', 'frontend', 'backend', 'mobile', 'ios', 'android', 'flutter', 'fastapi',
            'django', 'nextjs', 'vue', 'api',
        ],
    },
    {
        name: 'architecture',
        keywords: [
            'architecture', 'c4', 'microservices', 'event', 'cqrs', 'saga', 'domain', 'ddd', 'patterns',
            'decision', 'adr',
        ],
    },
    {
        name: 'testing',
        keywords: ['testing', 'tdd', 'unit', 'e2e', 'qa', 'test'],
    },
    {
        name: 'business',
        keywords: [
            'business', 'market', 'sales', 'finance', 'startup', 'legal', 'hr', 'product', 'customer', 'seo',
            'marketing', 'kpi', 'contract', 'employment',
        ],
    },
    {
        name: 'workflow',
        keywords: ['workflow', 'orchestration', 'conductor', 'automation', 'process', 'collaboration'],
    },
];

/**
 * Compute Jaccard similarity between two token arrays.
 */
function jaccardSimilarity(tokensA, tokensB) {
    if (!tokensA.length || !tokensB.length) return 0;
    const setA = new Set(tokensA);
    const setB = new Set(tokensB);
    let intersection = 0;
    for (const token of setA) {
        if (setB.has(token)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

/**
 * Score: Completeness (0-25)
 * Checks for name, description, instruction sections, use-when/do-not-use blocks.
 */
function scoreCompleteness(skill) {
    let score = 0;

    // Has a meaningful name (not just the directory ID)
    if (skill.name && skill.name !== skill.id && skill.name.length > 2) {
        score += 5;
    }

    // Has a description
    if (skill.description && skill.description.length > 20) {
        score += 5;
    } else if (skill.description && skill.description.length > 0) {
        score += 2;
    }

    // Has body content
    const body = (skill.content || '').toLowerCase();
    if (body.length > 100) {
        score += 3;
    }

    // Has "use this skill when" or "use when" section
    if (/use\s+(this\s+)?skill\s+when/i.test(body) || /##\s*use\s+when/i.test(body)) {
        score += 4;
    }

    // Has "do not use" section
    if (/do\s+not\s+use/i.test(body)) {
        score += 3;
    }

    // Has instructions/steps section
    if (/##\s*(instructions|steps|how to)/i.test(body)) {
        score += 3;
    }

    // Has tags
    if (skill.tags && skill.tags.length > 0) {
        score += 2;
    }

    return Math.min(score, 25);
}

/**
 * Score: Uniqueness (0-25)
 * Compares against existing catalog skills to penalize duplicates.
 */
function scoreUniqueness(skill, existingSkills) {
    if (!existingSkills || !existingSkills.length) return 25;

    const skillTokens = tokenize(`${skill.name} ${skill.description}`);

    let maxSimilarity = 0;
    let bestMatchId = null;

    for (const existing of existingSkills) {
        // Exact ID match
        if (existing.id === skill.id) {
            return { score: 0, duplicateOf: existing.id, isDuplicate: true };
        }

        const existingTokens = tokenize(`${existing.name || ''} ${existing.description || ''}`);
        const similarity = jaccardSimilarity(skillTokens, existingTokens);

        if (similarity > maxSimilarity) {
            maxSimilarity = similarity;
            bestMatchId = existing.id;
        }
    }

    // Threshold-based scoring
    if (maxSimilarity > 0.7) {
        return { score: 3, duplicateOf: bestMatchId, isDuplicate: true };
    }
    if (maxSimilarity > 0.5) {
        return { score: 10, duplicateOf: bestMatchId, isDuplicate: false };
    }
    if (maxSimilarity > 0.3) {
        return { score: 18, duplicateOf: null, isDuplicate: false };
    }

    return { score: 25, duplicateOf: null, isDuplicate: false };
}

/**
 * Score: Quality (0-25)
 * Evaluates description depth, body content quality, references, examples.
 */
function scoreQuality(skill) {
    let score = 0;
    const body = skill.content || '';

    // Description quality
    const descLen = (skill.description || '').length;
    if (descLen > 100) score += 5;
    else if (descLen > 50) score += 3;
    else if (descLen > 20) score += 1;

    // Body length (more content = more detailed)
    if (body.length > 2000) score += 5;
    else if (body.length > 1000) score += 4;
    else if (body.length > 500) score += 3;
    else if (body.length > 200) score += 2;

    // Has code examples
    if (/```/.test(body)) score += 4;

    // Has multiple sections (## headers)
    const sectionCount = (body.match(/^##\s/gm) || []).length;
    if (sectionCount >= 4) score += 4;
    else if (sectionCount >= 2) score += 2;
    else if (sectionCount >= 1) score += 1;

    // Has references or examples directory mentioned
    if (/references?\//i.test(body) || /examples?\//i.test(body) || /resources?\//i.test(body)) {
        score += 3;
    }

    // Has safety section
    if (/##\s*safety/i.test(body)) score += 2;

    // No parse errors
    if (!skill.parseErrors || skill.parseErrors.length === 0) {
        score += 2;
    }

    return Math.min(score, 25);
}

/**
 * Score: Repo Signals (0-25)
 * GitHub stars, forks, recency.
 */
function scoreRepoSignals(skill) {
    let score = 0;
    const source = skill.source || {};

    // Stars
    const stars = source.stars || 0;
    if (stars >= 500) score += 8;
    else if (stars >= 100) score += 6;
    else if (stars >= 50) score += 5;
    else if (stars >= 10) score += 3;
    else if (stars >= 1) score += 1;

    // Forks
    const forks = source.forks || 0;
    if (forks >= 100) score += 5;
    else if (forks >= 20) score += 4;
    else if (forks >= 5) score += 3;
    else if (forks >= 1) score += 1;

    // Recency (pushed within last 6 months = good)
    if (source.pushedAt) {
        const pushedDate = new Date(source.pushedAt);
        const now = new Date();
        const monthsAgo = (now - pushedDate) / (1000 * 60 * 60 * 24 * 30);

        if (monthsAgo < 1) score += 7;
        else if (monthsAgo < 3) score += 6;
        else if (monthsAgo < 6) score += 5;
        else if (monthsAgo < 12) score += 3;
        else if (monthsAgo < 24) score += 1;
    }

    // Has description on GitHub
    if (source.description) score += 2;

    return Math.min(score, 25);
}

/**
 * Assign a tier label based on total score.
 */
function assignTier(score) {
    if (score >= 75) return '★★★';
    if (score >= 50) return '★★';
    if (score >= 25) return '★';
    return '⬡';
}

/**
 * Categorize a skill using keyword rules.
 */
function categorizeSkill(skill) {
    const haystack = new Set(tokenize(
        `${skill.id} ${skill.name || ''} ${skill.description || ''} ${(skill.tags || []).join(' ')}`,
    ));

    for (const rule of CATEGORY_RULES) {
        for (const keyword of rule.keywords) {
            if (haystack.has(keyword)) {
                return rule.name;
            }
        }
    }

    return 'general';
}

/**
 * Rank a single discovered skill against the existing catalog.
 */
function rankSkill(skill, existingSkills) {
    const completeness = scoreCompleteness(skill);
    const uniquenessResult = scoreUniqueness(skill, existingSkills);
    const quality = scoreQuality(skill);
    const repoSignals = scoreRepoSignals(skill);

    const totalScore = completeness + uniquenessResult.score + quality + repoSignals;
    const tier = assignTier(totalScore);
    const category = categorizeSkill(skill);

    return {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        category,
        tags: skill.tags || [],
        source: skill.source,
        score: totalScore,
        tier,
        isDuplicate: uniquenessResult.isDuplicate,
        duplicateOf: uniquenessResult.duplicateOf,
        breakdown: {
            completeness,
            uniqueness: uniquenessResult.score,
            quality,
            repoSignals,
        },
    };
}

/**
 * Rank and deduplicate a batch of discovered skills.
 */
function rankAll(discoveredSkills, existingSkills) {
    const ranked = discoveredSkills.map((skill) => rankSkill(skill, existingSkills));
    ranked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return ranked;
}

module.exports = {
    rankSkill,
    rankAll,
    categorizeSkill,
    assignTier,
    jaccardSimilarity,
    scoreCompleteness,
    scoreUniqueness,
    scoreQuality,
    scoreRepoSignals,
    CATEGORY_RULES,
};
