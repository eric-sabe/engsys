'use strict';

const { path, exists, fs } = require('./util');

// Resolve which stack packs a config selects, as [category, value] paths
// under stacks/. Order matters only for display.
function selectedPacks(config) {
  const stack = config.stack || {};
  const packs = [];
  const seen = new Set();
  const add = (cat, val) => {
    if (!val || val === 'none') return;
    const rel = path.join(cat, String(val));
    if (seen.has(rel)) return;
    seen.add(rel);
    packs.push(rel);
  };
  // Every stack dimension accepts a scalar OR a list — mixed stacks compose.
  for (const c of [].concat(stack.cloud || [])) add('cloud', c);
  for (const i of [].concat(stack.iac || [])) add('iac', i);
  for (const d of [].concat(stack.db || [])) add('db', d);
  for (const l of [].concat(stack.lang || [])) add('lang', l);
  for (const p of [].concat(stack.platform || [])) add('platform', p);
  for (const d of [].concat(stack.domain || [])) add('domain', d);
  // Issue tracker resolves as a pack too. Defaults to github (zero-config keeps
  // today's behavior); set `issue_tracker: none` to opt out entirely.
  for (const t of [].concat(config.issue_tracker || 'github')) {
    if (t && t !== 'none') add('tooling', `issue-tracker-${t}`);
  }
  return packs;
}

function listMd(dir) {
  if (!exists(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
}

// Build the full install plan: every copy operation + every fragment to merge.
function buildManifest(engsysRoot, config) {
  const core = path.join(engsysRoot, 'core');
  const plan = {
    agents: [],      // { src, name }
    commands: [],    // { src, name, description }
    skillDirs: [],   // { src(dir), name }  -> copied into .claude/skills/<name>
    workflows: [],   // { src, name }
    packHooks: [],   // { src, name } -> copied verbatim into .claude/hooks/
    claudeFragments: [], // { pack, text }
    settingsFragments: [], // parsed json objects
    mcpServers: {},  // merged
    packs: selectedPacks(config),
    warnings: [],
  };

  const seenAgent = new Set();
  const addAgent = (src, name) => {
    if (seenAgent.has(name)) { plan.warnings.push(`duplicate agent '${name}' skipped (${src})`); return; }
    seenAgent.add(name);
    plan.agents.push({ src, name });
  };

  // --- core agents ---
  const agentSel = (config.agents && config.agents.core) || 'all';
  const coreAgentsDir = path.join(core, 'agents');
  const coreAgentFiles = agentSel === 'all'
    ? listMd(coreAgentsDir)
    : [].concat(agentSel).map((n) => `${n}.md`);
  for (const f of coreAgentFiles) {
    const src = path.join(coreAgentsDir, f);
    if (!exists(src)) { plan.warnings.push(`core agent not found: ${f}`); continue; }
    addAgent(src, f);
  }

  // --- extra (optional) agents ---
  const extra = (config.agents && config.agents.extra) || [];
  for (const n of [].concat(extra)) {
    const src = path.join(engsysRoot, 'optional-agents', `${n}.md`);
    if (!exists(src)) { plan.warnings.push(`optional agent not found: ${n}`); continue; }
    addAgent(src, `${n}.md`);
  }

  // --- commands ---
  const cmdSel = config.commands || 'all';
  const coreCmdDir = path.join(core, 'commands');
  const cmdFiles = cmdSel === 'all'
    ? listMd(coreCmdDir)
    : [].concat(cmdSel).map((n) => `${n}.md`);
  const { frontmatterDescription } = require('./util');
  for (const f of cmdFiles) {
    const src = path.join(coreCmdDir, f);
    if (!exists(src)) { plan.warnings.push(`command not found: ${f}`); continue; }
    plan.commands.push({ src, name: f, description: frontmatterDescription(src) });
  }

  // --- core skills (always all) ---
  const coreSkillsDir = path.join(core, 'skills');
  if (exists(coreSkillsDir)) {
    for (const d of fs.readdirSync(coreSkillsDir, { withFileTypes: true })) {
      if (d.isDirectory()) plan.skillDirs.push({ src: path.join(coreSkillsDir, d.name), name: d.name });
    }
  }

  // --- core workflows ---
  const wfDir = path.join(core, 'workflows');
  for (const f of listMd(wfDir)) plan.workflows.push({ src: path.join(wfDir, f), name: f });

  // --- stack packs ---
  const seenSkill = new Set(plan.skillDirs.map((s) => s.name));
  for (const rel of plan.packs) {
    const packDir = path.join(engsysRoot, 'stacks', rel);
    if (!exists(packDir)) { plan.warnings.push(`pack not found: ${rel}`); continue; }

    const skillsDir = path.join(packDir, 'skills');
    if (exists(skillsDir)) {
      for (const d of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        if (seenSkill.has(d.name)) { plan.warnings.push(`duplicate skill '${d.name}' from ${rel} skipped`); continue; }
        seenSkill.add(d.name);
        plan.skillDirs.push({ src: path.join(skillsDir, d.name), name: d.name });
      }
    }

    const agentsDir = path.join(packDir, 'agents');
    for (const f of listMd(agentsDir)) addAgent(path.join(agentsDir, f), f);

    const hooksDir = path.join(packDir, 'hooks');
    if (exists(hooksDir)) {
      for (const f of fs.readdirSync(hooksDir)) {
        plan.packHooks.push({ src: path.join(hooksDir, f), name: f });
      }
    }

    const frag = path.join(packDir, 'claude.fragment.md');
    if (exists(frag)) plan.claudeFragments.push({ pack: rel, text: require('./util').readText(frag).trim() });

    const sfrag = path.join(packDir, 'settings.fragment.json');
    if (exists(sfrag)) {
      try {
        const obj = JSON.parse(require('./util').readText(sfrag));
        plan.settingsFragments.push(obj);
        Object.assign(plan.mcpServers, obj.mcpServers || {});
      } catch (e) {
        plan.warnings.push(`invalid settings.fragment.json in ${rel}: ${e.message}`);
      }
    }
  }

  // Merge any MCP servers declared directly in naturalize config.
  if (config.naturalize && config.naturalize.mcp_servers) {
    Object.assign(plan.mcpServers, config.naturalize.mcp_servers);
  }

  return plan;
}

module.exports = { buildManifest, selectedPacks };
