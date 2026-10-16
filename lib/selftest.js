'use strict';

// Tiny zero-dep test harness for lib/. Run: npm test
const assert = require('assert');
const path = require('path');
const { parseYaml } = require('./yaml');
const render = require('./render');

const ENGSYS_ROOT = path.join(__dirname, '..');

let pass = 0;
function check(name, fn) { fn(); pass++; console.log(`  ok ${name}`); }

check('stack-tagged lessons seed only with a matching pack', () => {
  const { lessonAppliesToPacks: applies } = require('./commands');
  const prisma = '# X\n\n**Stack:** prisma (PostgreSQL). Skip if…\n';
  const react = '# X\n**Stack:** react. Skip if…\n';
  const plain = '# X\n\nGeneric.\n';
  if (!applies(plain, [])) throw new Error('untagged lesson must seed everywhere');
  if (applies(prisma, ['platform/web'])) throw new Error('prisma lesson seeded without the prisma pack');
  if (!applies(prisma, ['db/prisma', 'lang/typescript'])) throw new Error('prisma lesson not seeded with the prisma pack');
  if (!applies(react, ['platform/web'])) throw new Error('react lesson not seeded with the web pack');
  if (applies(react, [])) throw new Error('react lesson seeded without any pack');
});

check('scalars and inline lists', () => {
  const c = parseYaml(`
project:
  name: Acme Widgets
  description: A one-liner.
stack:
  cloud: aws
  iac: none
  lang: [typescript, python]
  db: none
commands: all
`);
  assert.strictEqual(c.project.name, 'Acme Widgets');
  assert.strictEqual(c.project.description, 'A one-liner.');
  assert.strictEqual(c.stack.cloud, 'aws');
  assert.deepStrictEqual(c.stack.lang, ['typescript', 'python']);
  assert.strictEqual(c.commands, 'all');
});

check('quoted strings keep punctuation', () => {
  const c = parseYaml(`
naturalize:
  model_strategy: "Opus for judgement; Sonnet for execution."
`);
  assert.strictEqual(c.naturalize.model_strategy, 'Opus for judgement; Sonnet for execution.');
});

check('block list of maps (hook_patterns)', () => {
  const c = parseYaml(`
naturalize:
  hook_patterns:
    - glob: "*/schema.prisma"
      reminder: "Regenerate the client."
    - glob: "docs/spec.md"
      reminder: "Bump the version header."
  invariants: []
`);
  assert.strictEqual(c.naturalize.hook_patterns.length, 2);
  assert.strictEqual(c.naturalize.hook_patterns[0].glob, '*/schema.prisma');
  assert.strictEqual(c.naturalize.hook_patterns[0].reminder, 'Regenerate the client.');
  assert.strictEqual(c.naturalize.hook_patterns[1].glob, 'docs/spec.md');
  assert.deepStrictEqual(c.naturalize.invariants, []);
});

check('agents block with extra list', () => {
  const c = parseYaml(`
agents:
  core: all
  extra: [sandy, gary]
`);
  assert.strictEqual(c.agents.core, 'all');
  assert.deepStrictEqual(c.agents.extra, ['sandy', 'gary']);
});

check('comments and bools', () => {
  const c = parseYaml(`
# a comment
stack:
  cloud: azure   # trailing comment
flag: true
empty: ~
`);
  assert.strictEqual(c.stack.cloud, 'azure');
  assert.strictEqual(c.flag, true);
  assert.strictEqual(c.empty, null);
});

check('block scalar (project_facts: |)', () => {
  const c = parseYaml(`
naturalize:
  project_facts: |
    - Serve with \`python3 -m http.server 8517\`.
    - Architecture: \`data.js\` is the read-only baseline.
  model_strategy: "after the block"
`);
  assert.strictEqual(
    c.naturalize.project_facts,
    '- Serve with `python3 -m http.server 8517`.\n- Architecture: `data.js` is the read-only baseline.\n'
  );
  assert.strictEqual(c.naturalize.model_strategy, 'after the block');
});

check('block scalar nested under a block-list map (hook_patterns reminder)', () => {
  const c = parseYaml(`
naturalize:
  hook_patterns:
    - glob: "docs/spec.md"
      reminder: |
        Bump the version header.
        Keep cross-refs in sync.
`);
  assert.strictEqual(
    c.naturalize.hook_patterns[0].reminder,
    'Bump the version header.\nKeep cross-refs in sync.\n'
  );
});

check('block scalar chomp indicators (strip/keep)', () => {
  const c = parseYaml(`
a: |-
  no trailing newline
b: |+
  keep trailing newline
c: >
  folded into
  one line
`);
  assert.strictEqual(c.a, 'no trailing newline');
  assert.strictEqual(c.b, 'keep trailing newline\n');
  assert.strictEqual(c.c, 'folded into one line\n');
});

check('inline flow maps (single-line stack/lessons)', () => {
  const c = parseYaml(`
project: {name: SeedTest, description: x}
stack: {cloud: aws, lang: [typescript, python], platform: [web]}
lessons: {seed: false}
`);
  assert.strictEqual(c.project.name, 'SeedTest');
  assert.strictEqual(c.stack.cloud, 'aws');
  assert.deepStrictEqual(c.stack.lang, ['typescript', 'python']);
  assert.deepStrictEqual(c.stack.platform, ['web']);
  assert.strictEqual(c.lessons.seed, false);
});

check('renderClaudeMd appends naturalize.invariants to project facts', () => {
  const config = {
    project: { name: 'Acme', description: 'desc' },
    naturalize: {
      project_facts: 'Base facts.',
      invariants: ['Never commit *.secret files.', 'Always run tests before push.'],
    },
  };
  const plan = { claudeFragments: [], mcpServers: {}, commands: [] };
  const out = render.renderClaudeMd(ENGSYS_ROOT, config, plan, null, null);
  assert.ok(out.includes('Base facts.'));
  assert.ok(out.includes('**Invariants (hard rules).**'));
  assert.ok(out.includes('- Never commit *.secret files.'));
  assert.ok(out.includes('- Always run tests before push.'));
});

check('renderClaudeMd omits the invariants heading when none are configured', () => {
  const config = { project: {}, naturalize: { project_facts: 'Base facts.' } };
  const plan = { claudeFragments: [], mcpServers: {}, commands: [] };
  const out = render.renderClaudeMd(ENGSYS_ROOT, config, plan, null, null);
  assert.ok(!out.includes('Invariants (hard rules)'));
});

check('renderMcpJson preserves naturalized values, refreshes unfilled placeholders', () => {
  const plan = {
    mcpServers: {
      xcodebuildmcp: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'xcodebuildmcp@latest', 'mcp'],
        env: {
          XCODEBUILDMCP_PROJECT_PATH: '<naturalize: path/to/App.xcodeproj>',
          XCODEBUILDMCP_SCHEME: '<naturalize: scheme>',
          XCODEBUILDMCP_PLATFORM: 'iOS Simulator',
        },
      },
    },
  };
  const existing = {
    mcpServers: {
      xcodebuildmcp: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'xcodebuildmcp@latest', 'mcp'],
        env: {
          XCODEBUILDMCP_PROJECT_PATH: 'App/App.xcodeproj',
          XCODEBUILDMCP_SCHEME: 'App',
          XCODEBUILDMCP_PLATFORM: 'iOS Simulator',
        },
      },
      custom: { type: 'stdio', command: 'my-own-server' },
    },
  };
  const out = JSON.parse(render.renderMcpJson(plan, existing));
  assert.strictEqual(out.mcpServers.xcodebuildmcp.env.XCODEBUILDMCP_PROJECT_PATH, 'App/App.xcodeproj');
  assert.strictEqual(out.mcpServers.xcodebuildmcp.env.XCODEBUILDMCP_SCHEME, 'App');
  assert.strictEqual(out.mcpServers.xcodebuildmcp.env.XCODEBUILDMCP_PLATFORM, 'iOS Simulator');
  assert.strictEqual(out.mcpServers.custom.command, 'my-own-server');
});

check('providers block (nested maps, per-role models)', () => {
  const c = parseYaml(`
providers:
  conductor: anthropic
  workers:
    codex:
      enabled: true
      models:
        implement: gpt-5.6-terra
        review: gpt-5.6-sol
    grok:
      enabled: false
  routing:
    implement_default: codex
    review_fallback_chain: [codex, grok, anthropic]
  parallel:
    enabled: false
    max_workers: 3
  timeouts:
    implement: 3600
`);
  assert.strictEqual(c.providers.conductor, 'anthropic');
  assert.strictEqual(c.providers.workers.codex.enabled, true);
  assert.strictEqual(c.providers.workers.codex.models.review, 'gpt-5.6-sol');
  assert.strictEqual(c.providers.workers.grok.enabled, false);
  assert.deepStrictEqual(c.providers.routing.review_fallback_chain, ['codex', 'grok', 'anthropic']);
  assert.strictEqual(c.providers.parallel.enabled, false);
  assert.strictEqual(c.providers.timeouts.implement, 3600);
});

check('normalizeProviders: defaults, families, disabled workers dropped', () => {
  const { normalizeProviders } = require('./render');
  const n = normalizeProviders({
    providers: {
      workers: {
        codex: { enabled: true, models: { implement: 'gpt-5.6-terra' } },
        grok: { enabled: false },
        deepseek: { enabled: true, models: { review: 'deepseek-v4-pro' } },
      },
    },
  });
  assert.deepStrictEqual(Object.keys(n.workers), ['codex', 'deepseek']);
  assert.strictEqual(n.workers.codex.family, 'openai');
  assert.strictEqual(n.workers.deepseek.family, 'deepseek');
  assert.strictEqual(n.routing.implement_default, 'codex');
  assert.strictEqual(n.routing.review, 'cross_family');
  // The chain contains only enabled workers — a disabled provider in the
  // fallback chain would be a dispatch that can never run.
  assert.deepStrictEqual(n.routing.review_fallback_chain, ['codex', 'deepseek']);
  assert.strictEqual(n.parallel.enabled, false);
  assert.strictEqual(n.timeouts.review, 2700);
});

check('normalizeProviders: no providers block → empty workers', () => {
  const { normalizeProviders, renderProviderRouting } = require('./render');
  const n = normalizeProviders({});
  assert.deepStrictEqual(n.workers, {});
  assert.ok(/No external worker providers/.test(renderProviderRouting({})));
});

check('providersBlock: parses, normalizes, and refuses unknown names', () => {
  const { providersBlock, normalizeProviders } = require('./render');
  const block = providersBlock(['codex', 'grok']);
  const parsed = parseYaml(block);
  const n = normalizeProviders(parsed);
  assert.deepStrictEqual(Object.keys(n.workers), ['codex', 'grok']);
  assert.strictEqual(n.workers.codex.models.review, 'gpt-5.6-sol');
  assert.strictEqual(parsed.providers.workers.grok.via, 'auto');
  assert.throws(() => providersBlock(['codex', 'gemini']), /unknown provider/);
});

check('selectedPacks includes enabled provider packs only', () => {
  const { selectedPacks } = require('./manifest');
  const packs = selectedPacks({
    stack: { lang: ['typescript'] },
    providers: { workers: { codex: { enabled: true }, grok: { enabled: false } } },
  });
  assert.ok(packs.includes('tooling/provider-codex'), `missing provider-codex in ${packs}`);
  assert.ok(!packs.some((p) => p.includes('provider-grok')), 'disabled grok pack selected');
});

check('fleet init: scaffold renders, refuses to overwrite, --force regenerates', () => {
  const fs = require('fs');
  const os = require('os');
  const { runFleetInit } = require('./commands');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engsys-fleet-init-'));
  try {
    const base = { engsysRoot: ENGSYS_ROOT, org: 'acme', namespace: 'acme', pinRepo: 'acme/app', pinDir: '/srv/app' };
    const min = path.join(tmp, 'min');
    const r = runFleetInit({ ...base, into: min });
    assert.ok(r.files.includes('fleet/fleet.conf') && r.files.includes('scripts/fleet'));
    assert.ok(r.files.includes('fleet/repos/acme/app/merge-monster.yml'), 'no marketplace → config dir in fleet/repos');
    assert.ok(!r.files.some((f) => f.startsWith('plugin/')), 'no marketplace → no plugin');
    for (const f of r.files) assert.ok(!fs.readFileSync(path.join(min, f), 'utf8').includes('{{'), `${f} has an unrendered token`);
    assert.ok(fs.readFileSync(path.join(min, 'fleet/roster.tmpl'), 'utf8').includes('__PIN_DIR__'), 'fleet-env tokens must pass through');
    assert.ok(fs.statSync(path.join(min, 'scripts/fleet')).mode & 0o100, 'shim is executable');
    assert.throws(() => runFleetInit({ ...base, into: min }), /refusing to overwrite/);
    fs.writeFileSync(path.join(min, 'README.md'), 'hand edited');
    runFleetInit({ ...base, into: min, force: true });
    assert.ok(!fs.readFileSync(path.join(min, 'README.md'), 'utf8').includes('hand edited'));
    const full = runFleetInit({ ...base, into: path.join(tmp, 'full'), instanceMarketplace: 'acme', identity: 'github-app', cloud: 'azure' });
    assert.ok(full.files.includes('plugin/hooks/fleet-context.sh') && full.files.includes('jobs/launchd/az-sp-login.plist.tmpl'));
    const rb = runFleetInit({ ...base, into: path.join(tmp, 'rb'), resourceBroker: true });
    assert.ok(rb.files.includes('fleet/repos/acme/app/resource-broker.yml') && rb.files.includes('fleet/repos/acme/app/acme-pool.json'), '--resource-broker adds the broker config and pool file');
    assert.ok(/^acme-broker\|__PIN_DIR__\|\/engsys:resource-broker/m.test(fs.readFileSync(path.join(tmp, 'rb/fleet/roster.tmpl'), 'utf8')), 'the broker roster line');
    assert.ok(!r.files.some((f) => f.includes('resource-broker')), 'no flag, no broker');
    assert.throws(() => runFleetInit({ ...base, into: path.join(tmp, 'x'), org: 'Not A Slug' }), /--org/);
    assert.throws(() => runFleetInit({ ...base, into: path.join(tmp, 'x'), pinRepo: 'nope' }), /--pin-repo/);
    assert.ok(!fs.existsSync(path.join(tmp, 'x')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

check('CT-PS-10: conditional skill manifest pruning (RETIRED_CORE_SKILLS + includeGhCli)', () => {
  const { buildManifest, RETIRED_CORE_SKILLS, includeGhCli } = require('./manifest');
  assert.deepStrictEqual([...RETIRED_CORE_SKILLS], ['git-commit', 'github-issues', 'terraform-conventions']);
  assert.strictEqual(includeGhCli({ issue_tracker: 'linear', stacks: ['tooling/linear'] }), false);
  assert.strictEqual(includeGhCli({ issue_tracker: 'linear', stacks: ['tooling/linear', 'tooling/github'] }), true);
  assert.strictEqual(includeGhCli({ issue_tracker: 'github' }), true);

  const planLinear = buildManifest(ENGSYS_ROOT, { issue_tracker: 'linear', stacks: ['tooling/linear'] });
  const skillNamesLinear = planLinear.skillDirs.map((s) => s.name);
  for (const retired of RETIRED_CORE_SKILLS) {
    assert.ok(!skillNamesLinear.includes(retired), `retired skill ${retired} must not be in manifest`);
  }
  assert.ok(!skillNamesLinear.includes('gh-cli'), 'gh-cli must be omitted when issue_tracker is linear without github pack');
  assert.ok(skillNamesLinear.includes('issue-tracker-linear'), 'issue-tracker-linear must be included');

  const planGithub = buildManifest(ENGSYS_ROOT, { issue_tracker: 'github' });
  const skillNamesGithub = planGithub.skillDirs.map((s) => s.name);
  assert.ok(skillNamesGithub.includes('gh-cli'), 'gh-cli must be included when issue_tracker is github');
  assert.ok(skillNamesGithub.includes('issue-tracker-github'), 'issue-tracker-github must be included');
});

check('CT-10: runInstall, runVerify, and zero-residue runUninstall across claude, copilot, antigravity, and all', () => {
  const fs = require('fs');
  const os = require('os');
  const { runInstall, runVerify, runUninstall } = require('./commands');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engsys-multi-harness-'));

  function listTree(dir, root = dir) {
    const entries = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p);
      if (e.isDirectory()) {
        entries.push(`dir:${rel}`);
        entries.push(...listTree(p, root));
      } else {
        entries.push(`file:${rel}`);
      }
    }
    return entries.sort();
  }

  try {
    for (const harness of ['claude', 'copilot', 'antigravity', 'all']) {
      const target = path.join(tmp, harness);
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(
        path.join(target, 'engsys.config.yaml'),
        `project:\n  name: Test-${harness}\n  description: Multi-harness test\nharness: ${harness}\nstack:\n  lang: [typescript]\nissue_tracker: github\n`
      );
      const beforeTree = listTree(target);
      const res = runInstall({ engsysRoot: ENGSYS_ROOT, into: target, mode: 'install' });
      assert.strictEqual(res.harness, harness);

      if (harness === 'claude' || harness === 'copilot' || harness === 'all') {
        assert.ok(fs.existsSync(path.join(target, 'CLAUDE.md')), `${harness}: missing CLAUDE.md`);
        assert.ok(fs.existsSync(path.join(target, '.claude/settings.json')), `${harness}: missing .claude/settings.json`);
        assert.ok(fs.existsSync(path.join(target, '.claude/hooks/handback-guard.mjs')), `${harness}: missing .claude/hooks/handback-guard.mjs`);
        assert.ok(fs.existsSync(path.join(target, '.claude/hooks/subagent-memory-inject.mjs')), `${harness}: missing .claude/hooks/subagent-memory-inject.mjs`);
        assert.ok(fs.existsSync(path.join(target, '.claude/hooks/weather-check.mjs')), `${harness}: missing .claude/hooks/weather-check.mjs`);
        assert.ok(fs.existsSync(path.join(target, '.claude/scripts/memory-sync.mjs')), `${harness}: missing .claude/scripts/memory-sync.mjs`);
        assert.ok(fs.existsSync(path.join(target, '.claude/scripts/memory-brief.mjs')), `${harness}: missing .claude/scripts/memory-brief.mjs`);
        assert.ok(fs.existsSync(path.join(target, '.claude/workflows/briefs/project-brief-overlay.md')), `${harness}: missing .claude/workflows/briefs/project-brief-overlay.md`);
      }
      if (harness === 'antigravity') {
        assert.ok(!fs.existsSync(path.join(target, '.claude')), 'antigravity-only install must not create .claude/');
      }
      if (harness === 'copilot' || harness === 'all') {
        assert.ok(fs.existsSync(path.join(target, '.github/copilot/settings.json')), `${harness}: missing .github/copilot/settings.json`);
        assert.ok(fs.existsSync(path.join(target, 'AGENTS.md')), `${harness}: missing AGENTS.md`);
      }
      if (harness === 'antigravity' || harness === 'all') {
        assert.ok(fs.existsSync(path.join(target, '.agents/hooks.json')), `${harness}: missing .agents/hooks.json`);
        assert.ok(fs.existsSync(path.join(target, '.agents/skills/design-change/SKILL.md')), `${harness}: missing .agents/skills/design-change/SKILL.md`);
        assert.ok(fs.existsSync(path.join(target, 'AGENTS.md')), `${harness}: missing AGENTS.md`);
        assert.ok(fs.existsSync(path.join(target, 'GEMINI.md')), `${harness}: missing GEMINI.md`);
        assert.ok(fs.existsSync(path.join(target, '.agents/workflows/briefs/project-brief-overlay.md')), `${harness}: missing .agents/workflows/briefs/project-brief-overlay.md`);
        const melvinAgy = fs.readFileSync(path.join(target, '.agents/agents/melvin.md'), 'utf8');
        const isabelleAgy = fs.readFileSync(path.join(target, '.agents/agents/isabelle.md'), 'utf8');
        assert.ok(melvinAgy.includes('enable_write_tools: false'), 'critic melvin must have enable_write_tools: false in .agents');
        assert.ok(isabelleAgy.includes('enable_write_tools: true'), 'implementer isabelle must have enable_write_tools: true in .agents');
      }

      const ver = runVerify({ into: target, skipDoctor: true });
      assert.strictEqual(ver.ok, true, `${harness}: verify failed: missing=${ver.missing} modified=${ver.modified}`);

      const un = runUninstall({ into: target });
      assert.ok(un.removed.length > 0, `${harness}: uninstall should remove files`);
      const afterTree = listTree(target);
      assert.deepStrictEqual(afterTree, beforeTree, `${harness}: greenfield uninstall must leave zero leftover files or directories`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

check('CT-11: multi-stage config evolution (harness switch, pack add/remove, enable-providers, foreign AI config) + byte-for-byte rollback', () => {
  const fs = require('fs');
  const os = require('os');
  const { sha256 } = require('./util');
  const { runInstall, runVerify, runEnableProviders, runUninstall } = require('./commands');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engsys-rollback-matrix-'));

  function snapshotTree(dir, root = dir, map = {}) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p);
      if (e.isDirectory()) {
        map[`dir:${rel}`] = 'DIR';
        snapshotTree(p, root, map);
      } else {
        map[`file:${rel}`] = sha256(fs.readFileSync(p, 'utf8'));
      }
    }
    return map;
  }

  try {
    // 0. Seed a rich pre-existing repository before engsys ever runs.
    const write = (rel, content) => {
      const abs = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
    };
    write('CLAUDE.md', '# Legacy Claude Guide\nAlways run legacy-check.\n');
    write('AGENTS.md', '# Legacy Agents Guide\nPre-existing agents doc.\n');
    write('GEMINI.md', '# Legacy Gemini Guide\nPre-existing gemini doc.\n');
    write('.claude/settings.json', JSON.stringify({
      permissions: { allow: ['Bash(legacy-preinstall:*)'], deny: ['Bash(legacy-deny:*)'] },
    }, null, 2) + '\n');
    write('.mcp.json', JSON.stringify({
      mcpServers: { 'legacy-mcp': { type: 'stdio', command: 'legacy-mcp-bin' } },
    }, null, 2) + '\n');
    write('.claude/agents/melvin.md', '# Pre-existing custom Melvin\n');
    write('.claude/agents/custom-bot.md', '# Project-owned custom agent\n');
    write('.agents/agents/agy-custom.md', '# Project-owned Antigravity agent\n');
    write('docs/agent-lessons/project-own-lesson.md', '# Project-owned lesson\n');
    write('.cursorrules', 'Always prefer functional style.\n');
    const initialConfig = [
      'project:',
      '  name: MatrixRepo',
      '  description: Rollback matrix test',
      'harness: claude',
      'stack:',
      '  cloud: aws',
      '  platform: [ios]',
      '  lang: [typescript]',
      'issue_tracker: github',
      '',
    ].join('\n');
    write('engsys.config.yaml', initialConfig);

    const baseline = snapshotTree(tmp);

    // 1. Initial install (harness: claude, cloud: aws, platform: [ios]).
    const r1 = runInstall({ engsysRoot: ENGSYS_ROOT, into: tmp, mode: 'install' });
    assert.strictEqual(r1.foldedClaude, true, 'must fold pre-existing CLAUDE.md');
    assert.strictEqual(r1.importedNow, true, 'must snapshot .cursorrules into docs/imported-ai-config');
    assert.ok(fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf8').includes('Always run legacy-check.'));
    assert.strictEqual(fs.readFileSync(path.join(tmp, 'AGENTS.md'), 'utf8'), '# Legacy Agents Guide\nPre-existing agents doc.\n', 'AGENTS.md untouched when harness is claude');
    const s1 = JSON.parse(fs.readFileSync(path.join(tmp, '.claude/settings.json'), 'utf8'));
    assert.ok(s1.permissions.allow.includes('Bash(legacy-preinstall:*)'), 'pre-existing allow preserved');
    assert.ok(s1.permissions.allow.some((p) => p.includes('aws ')), 'aws pack permissions merged');
    const m1 = JSON.parse(fs.readFileSync(path.join(tmp, '.mcp.json'), 'utf8'));
    assert.ok(m1.mcpServers['legacy-mcp'] && m1.mcpServers.xcodebuildmcp, 'both legacy-mcp and ios xcodebuildmcp present');

    // Simulate user naturalizing overlay and hand-adding a permission in settings.json.
    s1.permissions.allow.push('Bash(hand-added-during-session:*)');
    write('.claude/settings.json', JSON.stringify(s1, null, 2) + '\n');
    write('.claude/workflows/briefs/project-brief-overlay.md', '# Naturalized Overlay Content\n');

    // 2. Enable external worker providers (appends providers: to engsys.config.yaml + runs update).
    runEnableProviders({ engsysRoot: ENGSYS_ROOT, into: tmp, providers: ['codex', 'grok'] });
    assert.ok(fs.existsSync(path.join(tmp, '.claude/scripts/providers.json')), 'providers.json generated');
    assert.ok(fs.existsSync(path.join(tmp, '.claude/scripts/worker-run.mjs')), 'worker-run.mjs installed');
    assert.strictEqual(
      fs.readFileSync(path.join(tmp, '.claude/workflows/briefs/project-brief-overlay.md'), 'utf8'),
      '# Naturalized Overlay Content\n',
      'naturalized project-brief-overlay.md must survive enable-providers / update'
    );

    // 3. Evolve config: harness: all, switch cloud: aws -> gcp, platform: [ios] -> [web], issue_tracker: linear, drop providers:.
    write('engsys.config.yaml', [
      'project:',
      '  name: MatrixRepo',
      '  description: Rollback matrix test',
      'harness: all',
      'stack:',
      '  cloud: gcp',
      '  platform: [web]',
      '  lang: [typescript]',
      'issue_tracker: linear',
      'agents:',
      '  core: all',
      '  extra: [deandre, sandy]',
      '',
    ].join('\n'));
    runInstall({ engsysRoot: ENGSYS_ROOT, into: tmp, mode: 'update' });
    const s3 = JSON.parse(fs.readFileSync(path.join(tmp, '.claude/settings.json'), 'utf8'));
    assert.ok(!s3.permissions.allow.some((p) => p.includes('aws ')), 'deselected aws pack permissions must be pruned on update');
    assert.ok(s3.permissions.allow.includes('Bash(legacy-preinstall:*)'), 'pre-existing allow still preserved');
    assert.ok(s3.permissions.allow.includes('Bash(hand-added-during-session:*)'), 'hand-added allow still preserved');
    const m3 = JSON.parse(fs.readFileSync(path.join(tmp, '.mcp.json'), 'utf8'));
    assert.ok(!m3.mcpServers.xcodebuildmcp, 'deselected ios xcodebuildmcp server must be pruned on update');
    assert.ok(m3.mcpServers['legacy-mcp'], 'pre-existing legacy-mcp server still preserved');
    assert.ok(!fs.existsSync(path.join(tmp, '.claude/scripts/providers.json')), 'providers.json must be pruned when providers: removed');
    assert.ok(!fs.existsSync(path.join(tmp, '.claude/scripts/worker-run.mjs')), 'worker-run.mjs must be pruned when providers: removed');
    assert.ok(!fs.existsSync(path.join(tmp, '.claude/skills/gh-cli')), 'gh-cli must be pruned when switched to linear');
    assert.strictEqual(runVerify({ into: tmp, skipDoctor: true }).ok, true, 'verify must pass after harness: all update');

    // 4. Evolve config to harness: antigravity only and lessons: { seed: false }.
    write('engsys.config.yaml', [
      'project:',
      '  name: MatrixRepo',
      '  description: Rollback matrix test',
      'harness: antigravity',
      'stack:',
      '  lang: [typescript]',
      'lessons:',
      '  seed: false',
      '',
    ].join('\n'));
    runInstall({ engsysRoot: ENGSYS_ROOT, into: tmp, mode: 'update' });
    assert.ok(!fs.existsSync(path.join(tmp, '.claude/engsys.lock')), '.claude/engsys.lock removed when switched to antigravity');
    assert.ok(fs.existsSync(path.join(tmp, '.agents/engsys.lock')), '.agents/engsys.lock present');
    assert.ok(fs.existsSync(path.join(tmp, '.agents/.engsys-backup/manifest.json')), 'backup migrated to .agents/.engsys-backup');
    assert.strictEqual(
      fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf8'),
      '# Legacy Claude Guide\nAlways run legacy-check.\n',
      'pre-existing CLAUDE.md restored immediately when claude harness deselected'
    );
    assert.strictEqual(
      fs.readFileSync(path.join(tmp, '.claude/agents/melvin.md'), 'utf8'),
      '# Pre-existing custom Melvin\n',
      'pre-existing .claude/agents/melvin.md restored when claude harness deselected'
    );
    assert.ok(!fs.existsSync(path.join(tmp, 'docs/agent-lessons/library')), 'seeded lesson library pruned when seed: false');
    assert.ok(fs.existsSync(path.join(tmp, 'docs/agent-lessons/project-own-lesson.md')), 'project-owned lesson preserved');
    assert.strictEqual(runVerify({ into: tmp, skipDoctor: true }).ok, true, 'verify must pass on antigravity-only update');

    // Restore initial config text (or let uninstall restore the pre-enable-providers snapshot) and run uninstall.
    runUninstall({ into: tmp });
    const after = snapshotTree(tmp);
    assert.deepStrictEqual(after, baseline, 'uninstall after multi-stage evolution must restore the repo byte-for-byte');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

console.log(`\n${pass} checks passed.`);

