'use strict';

const { path, readText, exists, uniq } = require('./util');

const PF_START = '<!-- ENGSYS:PROJECT-FACTS:START -->';
const PF_END = '<!-- ENGSYS:PROJECT-FACTS:END -->';

function fill(tmpl, vars) {
  return tmpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? vars[k] : `{{${k}}}`));
}

function renderCommandsList(commands) {
  if (!commands.length) return '_No commands installed._';
  return commands
    .map((c) => {
      const name = c.name.replace(/\.md$/, '');
      const desc = c.description ? ` — ${c.description}` : '';
      return `- \`/${name}\`${desc}`;
    })
    .join('\n');
}

function renderMcpServers(mcpServers) {
  const keys = Object.keys(mcpServers);
  if (!keys.length) return '_No MCP servers required by the selected stack._';
  return keys
    .map((k) => {
      const s = mcpServers[k];
      const loc = s.url || (s.command ? `${s.command} ${(s.args || []).join(' ')}` : '');
      return `- \`${k}\` — ${s.type || 'stdio'}${loc ? ` (${loc})` : ''}`;
    })
    .join('\n');
}

// Render CLAUDE.md from template. On update, preserve the PROJECT-FACTS region
// from the existing file.
function renderClaudeMd(engsysRoot, config, plan, existingClaudeMd, seedFacts) {
  const tmpl = readText(path.join(engsysRoot, 'core', 'templates', 'CLAUDE.md.tmpl'));
  const project = config.project || {};
  const nat = config.naturalize || {};

  const stackFragments = plan.claudeFragments.length
    ? plan.claudeFragments.map((f) => f.text).join('\n\n')
    : '## Stack\n\n_No stack packs selected._';

  let projectFacts = nat.project_facts ||
    '> TODO (naturalize): describe this project — services, runtimes, build/verify toolchain, hard invariants, key paths. Run `/naturalize` or fill this in by hand.';

  // A foreign CLAUDE.md (or imported AI config) seeds the facts on first adoption.
  if (seedFacts) projectFacts = seedFacts;

  // Preserve hand-edited project facts on update (prior engsys region wins).
  if (existingClaudeMd) {
    const s = existingClaudeMd.indexOf(PF_START);
    const e = existingClaudeMd.indexOf(PF_END);
    if (s !== -1 && e !== -1 && e > s) {
      const preserved = existingClaudeMd.slice(s + PF_START.length, e).trim();
      if (preserved) projectFacts = preserved;
    }
  }

  const lessonsCfg = config.lessons || {};
  const lessonsNote = lessonsCfg.seed === false
    ? 'Project-specific lessons accrue in `docs/agent-lessons/`.'
    : `Cross-project lessons are seeded under \`${lessonsCfg.into || 'docs/agent-lessons/library'}\` — consult them before implementing. Project-specific lessons accrue in \`docs/agent-lessons/\` and graduate back to the engsys lessons-library by PR.`;

  return fill(tmpl, {
    PROJECT_NAME: project.name || 'Project',
    PROJECT_DESCRIPTION: project.description || '',
    MODEL_STRATEGY: nat.model_strategy ||
      'Opus for orchestration, synthesis, and judgement; Sonnet for execution. Escalate to Opus when a task needs cross-file reasoning, security analysis, or design tradeoffs.',
    STACK_FRAGMENTS: stackFragments,
    MCP_SERVERS: renderMcpServers(plan.mcpServers),
    COMMANDS_LIST: renderCommandsList(plan.commands),
    PROJECT_FACTS: projectFacts,
    LESSONS_NOTE: lessonsNote,
  });
}

// Merge base settings template with pack permission fragments (+ optional
// existing settings on update, to preserve hand-added permissions).
function renderSettings(engsysRoot, plan, existingSettings) {
  const base = JSON.parse(readText(path.join(engsysRoot, 'core', 'templates', 'settings.json.tmpl')));
  base.permissions = base.permissions || { allow: [], deny: [] };
  let allow = base.permissions.allow || [];
  let deny = base.permissions.deny || [];

  for (const frag of plan.settingsFragments) {
    if (frag.permissions) {
      allow = allow.concat(frag.permissions.allow || []);
      deny = deny.concat(frag.permissions.deny || []);
    }
  }
  if (existingSettings && existingSettings.permissions) {
    allow = allow.concat(existingSettings.permissions.allow || []);
    deny = deny.concat(existingSettings.permissions.deny || []);
  }

  base.permissions.allow = uniq(allow).sort();
  base.permissions.deny = uniq(deny).sort();
  return JSON.stringify(base, null, 2) + '\n';
}

function renderSettingsLocal(engsysRoot, plan) {
  const base = JSON.parse(readText(path.join(engsysRoot, 'core', 'templates', 'settings.local.json.tmpl')));
  base.enabledMcpjsonServers = Object.keys(plan.mcpServers).sort();
  return JSON.stringify(base, null, 2) + '\n';
}

function renderMcpJson(plan, existingMcp) {
  const servers = Object.assign({}, (existingMcp && existingMcp.mcpServers) || {}, plan.mcpServers);
  return JSON.stringify({ mcpServers: servers }, null, 2) + '\n';
}

function renderHook(engsysRoot, config) {
  const tmpl = readText(path.join(engsysRoot, 'core', 'templates', 'post-edit-reminders.sh.tmpl'));
  const patterns = (config.naturalize && config.naturalize.hook_patterns) || [];
  let cases;
  if (!patterns.length) {
    cases = '  # No project reminders configured yet. Add them under naturalize.hook_patterns.';
  } else {
    cases = patterns
      .map((p) => {
        const reminder = String(p.reminder || '').replace(/"/g, '\\"');
        return `  ${p.glob})\n    echo "↳ ${reminder}" ;;`;
      })
      .join('\n');
  }
  return fill(tmpl, { REMINDER_CASES: cases });
}

module.exports = {
  renderClaudeMd, renderSettings, renderSettingsLocal, renderMcpJson, renderHook,
  PF_START, PF_END,
};
