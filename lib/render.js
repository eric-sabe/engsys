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

// --- Worker providers (docs/multi-provider-spec.md § 6.3) -------------------
// The providers: block renders twice from one source: a machine-readable
// .claude/scripts/providers.json that worker-run/worker-package enforce, and a
// human routing table in CLAUDE.md. One source, so they can never disagree.

const PROVIDER_FAMILIES = { codex: 'openai', deepseek: 'deepseek', grok: 'xai', anthropic: 'anthropic' };
const ALL_ROLES = ['implement', 'review', 'critique', 'investigate'];

function normalizeProviders(config) {
  const p = config.providers || {};
  const workers = {};
  for (const [name, w] of Object.entries(p.workers || {})) {
    if (!w || typeof w !== 'object' || w.enabled === false) continue;
    workers[name] = {
      enabled: true,
      family: w.family || PROVIDER_FAMILIES[name] || name,
      roles: [].concat(w.roles || (name === 'grok' ? ['review', 'critique', 'investigate'] : ALL_ROLES)),
      models: w.models || {},
      via: w.via || undefined,
    };
  }
  const routing = p.routing || {};
  const enabledNames = Object.keys(workers);
  const defaultChain = ['codex', 'grok', 'deepseek', 'anthropic'].filter((n) => enabledNames.includes(n));
  return {
    conductor: p.conductor || 'anthropic',
    workers,
    routing: {
      implement_default: routing.implement_default || (enabledNames.includes('codex') ? 'codex' : enabledNames[0] || null),
      review: routing.review || 'cross_family',
      review_fallback_chain: [].concat(routing.review_fallback_chain || defaultChain),
      overflow: routing.overflow || (enabledNames.includes('deepseek') ? 'deepseek' : null),
      critique: routing.critique || (enabledNames.includes('grok') ? 'grok' : null),
    },
    parallel: {
      enabled: (p.parallel && p.parallel.enabled) === true,
      max_workers: (p.parallel && p.parallel.max_workers) || 3,
      require_nonoverlapping_touches: (p.parallel && p.parallel.require_nonoverlapping_touches) !== false,
    },
    timeouts: Object.assign({ implement: 3600, review: 2700, critique: 1800, investigate: 1800 }, p.timeouts || {}),
  };
}

function renderProvidersJson(config) {
  return JSON.stringify(normalizeProviders(config), null, 2) + '\n';
}

// Per-role model defaults used when `enable-providers` writes a fresh block.
// One place, so the subcommand, the example config, and the docs agree.
const PROVIDER_DEFAULT_MODELS = {
  codex: { implement: 'gpt-5.6-terra', review: 'gpt-5.6-sol', critique: 'gpt-5.6-sol', investigate: 'gpt-5.6-terra' },
  deepseek: { implement: 'deepseek-v4-flash', review: 'deepseek-v4-pro', critique: 'deepseek-v4-pro', investigate: 'deepseek-v4-pro' },
  grok: { review: 'grok-4.5', critique: 'grok-4.5', investigate: 'grok-4.5' },
  anthropic: { implement: 'sonnet', review: 'opus', critique: 'opus', investigate: 'sonnet' },
};

// The providers: block `engsys enable-providers` appends to a project config.
// Emitted in the same block style as engsys.config.example.yaml so the mini
// YAML parser and human readers see the identical shape.
function providersBlock(names) {
  const unknown = names.filter((n) => !(n in PROVIDER_DEFAULT_MODELS));
  if (unknown.length) {
    throw new Error(`unknown provider(s): ${unknown.join(', ')} — known: ${Object.keys(PROVIDER_DEFAULT_MODELS).join(', ')}`);
  }
  const lines = [
    '',
    '# Worker providers (docs/multi-provider-spec.md) — added by `engsys enable-providers`.',
    '# Models are per-role defaults; worker-run --model overrides per dispatch.',
    'providers:',
    '  workers:',
  ];
  for (const name of names) {
    lines.push(`    ${name}:`);
    lines.push('      enabled: true');
    if (name === 'grok') lines.push('      via: auto     # cli (Grok Build subscription) | api (XAI_API_KEY) | auto');
    lines.push('      models:');
    for (const [role, model] of Object.entries(PROVIDER_DEFAULT_MODELS[name])) {
      lines.push(`        ${role}: ${model}`);
    }
  }
  return lines.join('\n') + '\n';
}

function renderProviderRouting(config) {
  const n = normalizeProviders(config);
  const names = Object.keys(n.workers);
  if (!names.length) return '_No external worker providers configured (providers: block in engsys.config.yaml)._';
  const rows = names.map((name) => {
    const w = n.workers[name];
    const models = Object.entries(w.models).map(([r, m]) => `${r}: \`${m}\``).join(', ') || '—';
    return `| ${name} | ${w.family} | ${w.roles.join(', ')} | ${models} |`;
  });
  const lines = [
    'External models work as **workers** under the worker contract',
    '([worker-dispatch](.claude/workflows/worker-dispatch.md)): package in, receipt out,',
    'conductor owns gates, commits, and merges. Machine-readable routing:',
    '[providers.json](.claude/scripts/providers.json).',
    '',
    '| Worker | Family | Roles | Models |',
    '|--------|--------|-------|--------|',
    ...rows,
    '',
    `- **Hard rule: author family ≠ reviewer family.** Review fallback chain: ${n.routing.review_fallback_chain.join(' → ')} (minus the author's family). Same-family review only with explicit operator sign-off, logged as an exception.`,
    `- Implement default: **${n.routing.implement_default || '—'}**${n.routing.overflow ? `; overflow: **${n.routing.overflow}**` : ''}${n.routing.critique ? `; critique: **${n.routing.critique}**` : ''}. Judgment-heavy work stays with the conductor's personas.`,
    `- Workers never commit/push/PR — the conductor commits per issue with a \`Worker: <provider>/<model>\` trailer.`,
    n.parallel.enabled
      ? `- Parallel dispatch: ENABLED (max ${n.parallel.max_workers}, non-overlapping touches required).`
      : '- Parallel dispatch: disabled (serial until the § 8.3 preconditions in the multi-provider spec pass).',
  ];
  return lines.join('\n');
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
    PROVIDER_ROUTING: renderProviderRouting(config),
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
  renderProvidersJson, renderProviderRouting, normalizeProviders, providersBlock,
  PF_START, PF_END,
};
