#!/usr/bin/env node

const { Command } = require('commander');
const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const os = require('os');
const { listSkillIds, readSkill, tokenize, unique } = require('../lib/skill-utils');
const { searchForSkillRepos } = require('../lib/github-scanner');
const { rankAll, assignTier } = require('../lib/skill-ranker');
const { consolidate, parseDuration } = require('../scripts/consolidate');
const { loadRepoCatalog, getCatalogStats } = require('../lib/repo-catalog');
const { version } = require('../package.json');

const program = new Command();

// Resolve paths
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const SKILLS_SOURCE_DIR = path.join(PACKAGE_ROOT, 'skills');
const CATALOG_PATH = path.join(PACKAGE_ROOT, 'catalog.json');
const BUNDLES_PATH = path.join(PACKAGE_ROOT, 'bundles.json');
const ALIASES_PATH = path.join(PACKAGE_ROOT, 'aliases.json');

// Define destinations
const GLOBAL_SKILLS_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'skills');
const LOCAL_SKILLS_DIR = path.join(process.cwd(), '.agent', 'skills');

program
  .name('ag-skills')
  .description('Manage Antigravity Skills')
  .version(version);

function loadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return null;
  }
}

function loadCatalog() {
  const catalog = loadJson(CATALOG_PATH);
  if (catalog && Array.isArray(catalog.skills)) {
    return catalog;
  }

  const skillIds = listSkillIds(SKILLS_SOURCE_DIR);
  const skills = skillIds.map(skillId => {
    const skill = readSkill(SKILLS_SOURCE_DIR, skillId);
    const tags = unique([...(skill.tags || []), ...tokenize(skillId)]);
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      tags,
      category: 'general',
    };
  });

  return {
    skills,
    total: skills.length,
    _fallback: true,
  };
}

function loadBundles() {
  const bundles = loadJson(BUNDLES_PATH);
  if (bundles && bundles.bundles) return bundles;
  return { bundles: {}, common: [] };
}

function loadAliases() {
  const aliases = loadJson(ALIASES_PATH);
  if (aliases && aliases.aliases) return aliases.aliases;
  return {};
}

function sanitizeSkillId(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || !/^[a-z0-9-]+$/.test(normalized)) return null;
  return normalized;
}

function resolveSkillId(input, aliases) {
  const sanitized = sanitizeSkillId(input);
  if (!sanitized) return null;
  return aliases[sanitized] || sanitized;
}

function resolveSkillPath(skillId) {
  const resolved = path.resolve(SKILLS_SOURCE_DIR, skillId);
  if (!resolved.startsWith(SKILLS_SOURCE_DIR + path.sep)) return null;
  return resolved;
}

function truncate(value, limit) {
  if (!value) return '';
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 3)}...`;
}

function scoreSkill(skill, query, queryTokens) {
  const haystack = `${skill.id} ${skill.name || ''} ${skill.description || ''} ${(skill.tags || []).join(' ')}`.toLowerCase();
  let score = haystack.includes(query) ? 5 : 0;

  for (const token of queryTokens) {
    if (skill.id.toLowerCase().includes(token)) score += 3;
    if (haystack.includes(token)) score += 2;
  }

  return score;
}

function collectOption(value, previous) {
  const items = Array.isArray(previous) ? previous : [];
  const parts = String(value)
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
  return items.concat(parts);
}

function parseLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return 20;
  return parsed;
}

function checkDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return { exists: false, isDir: false, writable: false };
  }

  try {
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) {
      return { exists: true, isDir: false, writable: false };
    }
    fs.accessSync(dirPath, fs.constants.W_OK);
    return { exists: true, isDir: true, writable: true };
  } catch (err) {
    return { exists: true, isDir: true, writable: false };
  }
}

program
  .command('list')
  .description('List all available skills in the vault')
  .action(() => {
    try {
      const skills = listSkillIds(SKILLS_SOURCE_DIR);
      console.log(chalk.bold('\nAvailable Skills:\n'));
      skills.forEach(skill => {
        console.log(`- ${chalk.cyan(skill)}`);
      });
      console.log(chalk.green(`\nTotal: ${skills.length} skills`));
    } catch (err) {
      console.error(chalk.red('Error listing skills:'), err.message);
    }
  });

program
  .command('search <query>')
  .description('Search skills by name, description, and tags')
  .option('-l, --limit <number>', 'Limit results', parseLimit, 20)
  .action((query, options) => {
    const catalog = loadCatalog();
    const queryText = query.toLowerCase().trim();
    if (!queryText) {
      console.error(chalk.red('Error: Please provide a search query.'));
      process.exit(1);
    }

    if (catalog._fallback) {
      console.warn(chalk.yellow('Warning: catalog.json not found; using fallback metadata.'));
    }

    const queryTokens = unique(tokenize(queryText));
    const results = (catalog.skills || [])
      .map(skill => ({
        skill,
        score: scoreSkill(skill, queryText, queryTokens),
      }))
      .filter(result => result.score > 0)
      .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
      .slice(0, options.limit || 20);

    if (!results.length) {
      console.log(chalk.yellow('No matching skills found.'));
      return;
    }

    console.log(chalk.bold(`\nSearch results (${results.length}):\n`));
    for (const result of results) {
      const description = truncate(result.skill.description || '', 100);
      const tags = (result.skill.tags || []).slice(0, 6).join(', ');
      console.log(`- ${chalk.cyan(result.skill.id)}${description ? ` - ${description}` : ''}`);
      if (tags) {
        console.log(`  ${chalk.gray(`tags: ${tags}`)}`);
      }
    }
  });

program
  .command('install [skillName]')
  .description('Install a skill to your workspace or globally')
  .option('-g, --global', 'Install to global workspace (~/.gemini/antigravity/skills)')
  .option('-a, --all', 'Install ALL skills')
  .option('-t, --tag <tag>', 'Install skills by tag (repeatable)', collectOption, [])
  .option('-b, --bundle <bundle>', 'Install a curated bundle')
  .action(async (skillName, options) => {
    const targetDir = options.global ? GLOBAL_SKILLS_DIR : LOCAL_SKILLS_DIR;
    const aliases = loadAliases();
    const hasSkillName = typeof skillName === 'string' && skillName.trim().length > 0;
    const bundleName = options.bundle ? options.bundle.toLowerCase().trim() : '';
    const hasBundle = Boolean(bundleName);
    const hasTags = Array.isArray(options.tag) && options.tag.length > 0;
    const hasAll = Boolean(options.all);
    const selectedInputs = [hasSkillName, hasAll, hasBundle, hasTags].filter(Boolean);

    if (selectedInputs.length === 0) {
      console.error(chalk.red('Error: Please specify a skill name or use --all/--tag/--bundle'));
      process.exit(1);
    }

    if (selectedInputs.length > 1) {
      console.error(chalk.red('Error: Choose only one of skill name, --all, --tag, or --bundle'));
      process.exit(1);
    }

    try {
      await fs.ensureDir(targetDir);
      console.log(chalk.gray(`Target directory: ${targetDir}`));

      let skillsToInstall = [];

      if (hasAll) {
        console.warn(chalk.yellow('Warning: Installing all skills increases token usage and activation noise.'));
        skillsToInstall = listSkillIds(SKILLS_SOURCE_DIR);
      } else if (hasBundle) {
        const bundles = loadBundles();
        const bundle = bundles.bundles[bundleName];
        if (!bundle) {
          console.error(chalk.red(`Bundle '${bundleName}' not found.`));
          const available = Object.keys(bundles.bundles).sort();
          if (available.length) {
            console.log(chalk.gray(`Available bundles: ${available.join(', ')}`));
          } else {
            console.log(chalk.gray('Run npm run build:catalog to generate bundles.'));
          }
          process.exit(1);
        }
        if (!Array.isArray(bundle.skills) || bundle.skills.length === 0) {
          console.error(chalk.red(`Bundle '${bundleName}' has no skills.`));
          process.exit(1);
        }
        skillsToInstall = bundle.skills;
      } else if (hasTags) {
        const catalog = loadCatalog();
        const tagSet = new Set(options.tag.map(tag => tag.toLowerCase().trim()).filter(Boolean));
        skillsToInstall = (catalog.skills || [])
          .filter(skill => (skill.tags || []).some(tag => tagSet.has(String(tag).toLowerCase())))
          .map(skill => skill.id);

        if (!skillsToInstall.length) {
          console.error(chalk.red(`No skills found for tags: ${Array.from(tagSet).join(', ')}`));
          process.exit(1);
        }
      } else if (hasSkillName) {
        const resolved = resolveSkillId(skillName.trim(), aliases);
        if (!resolved) {
          console.error(chalk.red(`Invalid skill name: '${skillName}'`));
          process.exit(1);
        }
        skillsToInstall = [resolved];
      }

      skillsToInstall = unique(skillsToInstall);
      if (!skillsToInstall.length) {
        console.log(chalk.yellow('No skills to install.'));
        return;
      }

      for (const skill of skillsToInstall) {
        const safeSkill = sanitizeSkillId(skill);
        if (!safeSkill) {
          console.error(chalk.red(`Invalid skill name: '${skill}'`));
          continue;
        }
        const sourcePath = resolveSkillPath(safeSkill);
        if (!sourcePath || !await fs.pathExists(sourcePath)) {
          console.error(chalk.red(`Skill '${safeSkill}' not found in vault.`));
          continue;
        }

        const destPath = path.join(targetDir, safeSkill);

        await fs.copy(sourcePath, destPath, { overwrite: true });
        console.log(`${chalk.green('✔ Installed:')} ${safeSkill}`);
      }

      console.log(chalk.bold.green('\nInstallation complete!'));
      console.log('Restart your agent session to see changes.');
    } catch (err) {
      console.error(chalk.red('Installation failed:'), err.message);
      process.exit(1);
    }
  });

program
  .command('installed')
  .description('List skills installed in your workspace')
  .option('-g, --global', 'List globally installed skills')
  .action(async (options) => {
    const targetDir = options.global ? GLOBAL_SKILLS_DIR : LOCAL_SKILLS_DIR;

    try {
      if (!await fs.pathExists(targetDir)) {
        console.log(chalk.yellow(`No skills directory found at: ${targetDir}`));
        return;
      }

      const installedSkills = await fs.readdir(targetDir);
      const filteredSkills = installedSkills.filter(f => !f.startsWith('.'));

      if (filteredSkills.length === 0) {
        console.log(chalk.yellow('No skills installed.'));
        return;
      }

      console.log(chalk.bold(`\nInstalled Skills (${options.global ? 'Global' : 'Local'}):\n`));
      filteredSkills.forEach(skill => {
        console.log(`- ${chalk.green(skill)}`);
      });
      console.log(chalk.gray(`\nLocation: ${targetDir}`));
    } catch (err) {
      console.error(chalk.red('Error listing installed skills:'), err.message);
    }
  });

program
  .command('update [skillName]')
  .description('Update installed skills from the vault')
  .option('-g, --global', 'Update globally installed skills')
  .action(async (skillName, options) => {
    const targetDir = options.global ? GLOBAL_SKILLS_DIR : LOCAL_SKILLS_DIR;
    const aliases = loadAliases();

    try {
      if (!await fs.pathExists(targetDir)) {
        console.error(chalk.red(`No installation found at: ${targetDir}`));
        return;
      }

      let skillsToUpdate = [];
      if (skillName) {
        const resolved = resolveSkillId(skillName, aliases);
        if (!resolved) {
          console.error(chalk.red(`Invalid skill name: '${skillName}'`));
          return;
        }
        if (await fs.pathExists(path.join(targetDir, resolved))) {
          skillsToUpdate.push(resolved);
        } else {
          console.error(chalk.red(`Skill '${skillName}' is not installed.`));
          return;
        }
      } else {
        const installed = await fs.readdir(targetDir);
        skillsToUpdate = installed.filter(f => !f.startsWith('.'));
      }

      if (skillsToUpdate.length === 0) {
        console.log(chalk.yellow('No skills to update.'));
        return;
      }

      console.log(chalk.bold(`Updating ${skillsToUpdate.length} skills...\n`));

      for (const skill of skillsToUpdate) {
        const safeSkill = sanitizeSkillId(skill);
        if (!safeSkill) {
          console.warn(chalk.yellow(`Warning: invalid skill name '${skill}'. Skipping.`));
          continue;
        }

        const sourcePath = resolveSkillPath(safeSkill);
        const destPath = path.join(targetDir, safeSkill);

        if (!sourcePath || !await fs.pathExists(sourcePath)) {
          console.warn(chalk.yellow(`⚠ Warning: Skill '${safeSkill}' no longer exists in vault. Skipping.`));
          continue;
        }

        await fs.copy(sourcePath, destPath, { overwrite: true });
        console.log(`${chalk.green('✔ Updated:')} ${safeSkill}`);
      }

      console.log(chalk.bold.green('\nUpdate complete!'));
    } catch (err) {
      console.error(chalk.red('Update failed:'), err.message);
      process.exit(1);
    }
  });

program
  .command('doctor')
  .description('Check install paths and catalog metadata')
  .action(() => {
    const localStatus = checkDir(LOCAL_SKILLS_DIR);
    const globalStatus = checkDir(GLOBAL_SKILLS_DIR);

    console.log(chalk.bold('\nEnvironment Check:\n'));

    if (fs.existsSync(SKILLS_SOURCE_DIR)) {
      const count = listSkillIds(SKILLS_SOURCE_DIR).length;
      console.log(`Vault directory: ${SKILLS_SOURCE_DIR} (${chalk.green('OK')}, ${count} skills)`);
    } else {
      console.log(`Vault directory: ${SKILLS_SOURCE_DIR} (${chalk.red('MISSING')})`);
    }

    const catalogExists = fs.existsSync(CATALOG_PATH);
    console.log(`catalog.json: ${catalogExists ? chalk.green('OK') : chalk.red('MISSING')}`);

    const bundlesExists = fs.existsSync(BUNDLES_PATH);
    console.log(`bundles.json: ${bundlesExists ? chalk.green('OK') : chalk.red('MISSING')}`);

    const aliasesExists = fs.existsSync(ALIASES_PATH);
    console.log(`aliases.json: ${aliasesExists ? chalk.green('OK') : chalk.red('MISSING')}`);

    console.log('');
    console.log(`Local skills dir: ${LOCAL_SKILLS_DIR} (${localStatus.exists && localStatus.isDir ? chalk.green(localStatus.writable ? 'OK' : 'NOT WRITABLE') : chalk.red('MISSING')})`);
    if (!localStatus.exists) {
      console.log(chalk.gray(`Create with: mkdir -p ${LOCAL_SKILLS_DIR}`));
    }

    console.log(`Global skills dir: ${GLOBAL_SKILLS_DIR} (${globalStatus.exists && globalStatus.isDir ? chalk.green(globalStatus.writable ? 'OK' : 'NOT WRITABLE') : chalk.red('MISSING')})`);
    if (!globalStatus.exists) {
      console.log(chalk.gray(`Create with: mkdir -p ${GLOBAL_SKILLS_DIR}`));
    }

    if (!catalogExists || !bundlesExists || !aliasesExists) {
      console.log('');
      console.log(chalk.gray('Run npm run build:catalog to regenerate catalog files.'));
    }
  });

program
  .command('stats')
  .description('Show catalog statistics')
  .action(() => {
    const catalog = loadCatalog();
    const bundles = loadBundles();
    const total = catalog.total || (catalog.skills || []).length;

    if (catalog._fallback) {
      console.warn(chalk.yellow('Warning: catalog.json not found; stats are based on minimal metadata.'));
    }

    const categoryCounts = new Map();
    for (const skill of catalog.skills || []) {
      const category = skill.category || 'general';
      categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
    }

    const sortedCategories = Array.from(categoryCounts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    console.log(chalk.bold('\nCatalog Stats:\n'));
    console.log(`Total skills: ${total}`);
    if (catalog.generatedAt) {
      console.log(`Catalog generated at: ${catalog.generatedAt}`);
    }
    console.log('');

    console.log('Category counts:');
    sortedCategories.forEach(([category, count]) => {
      console.log(`- ${category}: ${count}`);
    });

    if (bundles.common && bundles.common.length) {
      console.log('');
      console.log(`Common skills (curated): ${bundles.common.join(', ')}`);
    }
  });

program
  .command('scan [query]')
  .description('Quick search GitHub for public skill repos')
  .option('-l, --limit <number>', 'Max results', parseLimit, 20)
  .action(async (query, options) => {
    const searchQuery = query || 'filename:SKILL.md path:skills';
    console.log(chalk.bold(`\nScanning GitHub for: ${chalk.cyan(searchQuery)}\n`));
    try {
      const results = await searchForSkillRepos({
        queries: [searchQuery],
        limit: options.limit || 20,
      });
      if (!results.length) {
        console.log(chalk.yellow('No skill repos found. Try a different query.'));
        return;
      }

      const repos = new Map();
      for (const item of results) {
        if (!repos.has(item.repo)) {
          repos.set(item.repo, []);
        }
        repos.get(item.repo).push(item.path);
      }

      console.log(chalk.bold(`Found ${results.length} skills across ${repos.size} repos:\n`));
      for (const [repo, paths] of repos) {
        console.log(`${chalk.green('◉')} ${chalk.cyan(repo)} — ${paths.length} skill(s)`);
        for (const p of paths.slice(0, 5)) {
          console.log(`  ${chalk.gray(p)}`);
        }
        if (paths.length > 5) {
          console.log(chalk.gray(`  ... and ${paths.length - 5} more`));
        }
      }

      console.log(chalk.gray(`\nRun ${chalk.white('ag-skills consolidate')} for full ranking and inventory.`));
    } catch (err) {
      console.error(chalk.red('Scan failed:'), err.message);
      process.exit(1);
    }
  });

program
  .command('consolidate')
  .description('Scan, rank, and inventory public GitHub skills')
  .option('-q, --query <query>', 'GitHub search query', 'filename:SKILL.md path:skills')
  .option('-l, --limit <number>', 'Max skills to collect', parseLimit, 20)
  .option('-m, --min-score <number>', 'Minimum score to include', parseLimit, 0)
  .option('-o, --output <path>', 'Output directory')
  .option('-d, --duration <time>', 'Slow walk duration (e.g., 1h, 30m, 3h)')
  .action(async (options) => {
    const durationMs = options.duration ? parseDuration(options.duration) : 0;
    const durationLabel = durationMs
      ? `${(durationMs / 3600000).toFixed(1)} hour(s)`
      : 'single pass';
    console.log(chalk.bold('\n🔍 AI Skills Consolidator\n'));
    console.log(chalk.gray(`Mode: ${durationMs ? '🐢 Slow walk' : '⚡ Quick scan'} (${durationLabel})\n`));
    try {
      const inventory = await consolidate({
        query: options.query,
        limit: options.limit,
        minScore: options.minScore,
        output: options.output ? path.resolve(options.output) : undefined,
        durationMs,
      });

      if (inventory && inventory.skills.length) {
        console.log('');
        console.log(chalk.bold('Top Skills Found:\n'));
        const top = inventory.skills.slice(0, 10);
        for (const skill of top) {
          const tierColor = skill.tier === '★★★' ? chalk.green
            : skill.tier === '★★' ? chalk.yellow
              : chalk.gray;
          const dupBadge = skill.isDuplicate ? chalk.red(' [DUP]') : '';
          console.log(`  ${tierColor(skill.tier)} ${chalk.bold(String(skill.score).padStart(3))} ${chalk.cyan(skill.id)}${dupBadge}`);
          if (skill.description) {
            console.log(`       ${chalk.gray(truncate(skill.description, 80))}`);
          }
          console.log(`       ${chalk.gray(`from ${skill.source.repo} (★${skill.source.stars})`)}`);
        }
        if (inventory.skills.length > 10) {
          console.log(chalk.gray(`\n  ... and ${inventory.skills.length - 10} more. See discovered-skills.json for full list.`));
        }
        console.log(chalk.bold.green('\n✔ Consolidation complete!'));
      }
    } catch (err) {
      console.error(chalk.red('Consolidation failed:'), err.message);
      process.exit(1);
    }
  });

program
  .command('rank')
  .description('Display ranked skills from the discovered inventory')
  .option('-t, --tier <tier>', 'Filter by tier (3, 2, 1, or 0)')
  .option('-c, --category <category>', 'Filter by category')
  .option('-s, --sort <field>', 'Sort by: score, name, category', 'score')
  .option('-d, --duplicates', 'Show only duplicates')
  .action((options) => {
    const inventoryPath = path.join(PACKAGE_ROOT, 'discovered-skills.json');
    if (!fs.existsSync(inventoryPath)) {
      console.error(chalk.red('No discovered-skills.json found.'));
      console.log(chalk.gray('Run: ag-skills consolidate'));
      process.exit(1);
    }

    let inventory;
    try {
      inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
    } catch (err) {
      console.error(chalk.red('Failed to parse discovered-skills.json:'), err.message);
      process.exit(1);
    }

    let skills = inventory.skills || [];

    if (options.tier) {
      const tierMap = { '3': '★★★', '2': '★★', '1': '★', '0': '⬡' };
      const tierFilter = tierMap[options.tier] || options.tier;
      skills = skills.filter((s) => s.tier === tierFilter);
    }

    if (options.category) {
      const cat = options.category.toLowerCase();
      skills = skills.filter((s) => s.category === cat);
    }

    if (options.duplicates) {
      skills = skills.filter((s) => s.isDuplicate);
    }

    if (options.sort === 'name') {
      skills.sort((a, b) => a.id.localeCompare(b.id));
    } else if (options.sort === 'category') {
      skills.sort((a, b) => a.category.localeCompare(b.category) || b.score - a.score);
    }

    if (!skills.length) {
      console.log(chalk.yellow('No skills match the given filters.'));
      return;
    }

    console.log(chalk.bold(`\nRanked Skills (${skills.length}):\n`));
    console.log(chalk.gray(`Scanned: ${inventory.scannedAt} | Query: ${inventory.query}\n`));

    for (const skill of skills) {
      const tierColor = skill.tier === '★★★' ? chalk.green
        : skill.tier === '★★' ? chalk.yellow
          : chalk.gray;
      const dupBadge = skill.isDuplicate ? chalk.red(' [DUP]') : '';
      console.log(`${tierColor(skill.tier)} ${chalk.bold(String(skill.score).padStart(3))} ${chalk.cyan(skill.id)} ${chalk.gray(`[${skill.category}]`)}${dupBadge}`);
      if (skill.description) {
        console.log(`     ${chalk.gray(truncate(skill.description, 90))}`);
      }
      console.log(`     ${chalk.gray(`${skill.source.repo} ★${skill.source.stars}`)}`);
      if (skill.isDuplicate && skill.duplicateOf) {
        console.log(`     ${chalk.red(`duplicate of: ${skill.duplicateOf}`)}`);
      }
    }

    // Summary
    const tierCounts = { '★★★': 0, '★★': 0, '★': 0, '⬡': 0 };
    for (const s of skills) tierCounts[s.tier]++;
    console.log('');
    console.log(chalk.bold('Tier Summary:'));
    console.log(`  ${chalk.green('★★★')} ${tierCounts['★★★']}  ${chalk.yellow('★★')} ${tierCounts['★★']}  ${chalk.gray('★')} ${tierCounts['★']}  ${chalk.gray('⬡')} ${tierCounts['⬡']}`);
  });

program
  .command('repos')
  .description('Show the repo catalog — all repos checked and their status')
  .option('-s, --sort <field>', 'Sort by: name, stars, checked, skills', 'checked')
  .option('--stale <hours>', 'Only show repos not checked in N hours')
  .action((options) => {
    const catalog = loadRepoCatalog();
    const stats = getCatalogStats(catalog);
    const entries = Object.entries(catalog.repos);

    if (!entries.length) {
      console.log(chalk.yellow('No repos in catalog yet. Run: ag-skills consolidate'));
      return;
    }

    let repos = entries.map(([name, entry]) => ({ name, ...entry }));

    // Filter stale
    if (options.stale) {
      const hours = parseFloat(options.stale);
      const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      repos = repos.filter((r) => r.lastChecked < cutoff);
    }

    // Sort
    switch (options.sort) {
      case 'name':
        repos.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'stars':
        repos.sort((a, b) => (b.stars || 0) - (a.stars || 0));
        break;
      case 'skills':
        repos.sort((a, b) => (b.skillCount || 0) - (a.skillCount || 0));
        break;
      case 'checked':
      default:
        repos.sort((a, b) => (b.lastChecked || '').localeCompare(a.lastChecked || ''));
        break;
    }

    console.log(chalk.bold(`\nRepo Catalog (${repos.length} repos):\n`));
    console.log(chalk.gray(`Total tracked: ${stats.totalRepos} | With skills: ${stats.reposWithSkills} | Total skill files: ${stats.totalSkills}`));
    if (stats.lastUpdated) {
      console.log(chalk.gray(`Last updated: ${stats.lastUpdated}`));
    }
    console.log('');

    for (const repo of repos) {
      const skillBadge = repo.skillCount > 0
        ? chalk.green(`${repo.skillCount} skill(s)`)
        : chalk.gray('no skills');
      const statusIcon = repo.status === 'has-skills' ? chalk.green('◉')
        : repo.status === 'no-skills' ? chalk.gray('○')
          : chalk.yellow('?');

      console.log(`${statusIcon} ${chalk.cyan(repo.name)} — ★${repo.stars || 0} — ${skillBadge}`);
      console.log(`  ${chalk.gray(`Last checked: ${repo.lastChecked} | First seen: ${repo.firstSeen}`)}`);
      console.log(`  ${chalk.gray(`Checks: ${repo.checks ? repo.checks.length : 0} total`)}`);
      if (repo.skillIds && repo.skillIds.length) {
        const shown = repo.skillIds.slice(0, 5);
        console.log(`  ${chalk.gray(`Skills: ${shown.join(', ')}${repo.skillIds.length > 5 ? ` +${repo.skillIds.length - 5} more` : ''}`)}`);
      }
    }
  });

program
  .command('dashboard')
  .description('Launch the scanner control dashboard (web UI)')
  .option('-p, --port <number>', 'Port to listen on', '3847')
  .action((options) => {
    const { fork } = require('child_process');
    const dashboardPath = path.join(__dirname, '..', 'scripts', 'scanner-dashboard.js');
    const child = fork(dashboardPath, [], {
      env: { ...process.env, PORT: options.port },
      stdio: 'inherit',
    });
    child.on('error', (err) => {
      console.error(chalk.red('Dashboard failed:'), err.message);
      process.exit(1);
    });
  });

program
  .command('skills')
  .description('Launch the skills catalog dashboard (web UI)')
  .option('-p, --port <number>', 'Port to listen on', '3848')
  .action((options) => {
    const { fork } = require('child_process');
    const dashPath = path.join(__dirname, '..', 'scripts', 'skills-dashboard.js');
    const child = fork(dashPath, [], {
      env: { ...process.env, PORT: options.port },
      stdio: 'inherit',
    });
    child.on('error', (err) => {
      console.error(chalk.red('Skills dashboard failed:'), err.message);
      process.exit(1);
    });
  });

program.parse(process.argv);
