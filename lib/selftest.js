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

console.log(`\n${pass} checks passed.`);
