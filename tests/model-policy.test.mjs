// model-policy.test.mjs — the security tier stays on Claude Opus 4.8 on every harness, and the
// persona tool sets the security and test personas need are intact.
//
//  - engsys.config `models:` cannot move the security tier (models.security, or a key naming nyx or
//    any `security: true` agent): rejected with a clear error at render and at install.
//  - Rendering for Claude and Copilot keeps the security tier on Opus 4.8; Antigravity, which cannot
//    run it, gets a refusal stub instead of another model, and so does the scaffold fleet.conf.
//  - nyx (and marcelo) keep Bash.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const render = require(path.join(ROOT, 'lib/render.js'));
const { runInstall } = require(path.join(ROOT, 'lib/commands.js'));

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const NYX = read('core/agents/nyx.md');
const MARCELO = read('core/agents/marcelo.md');
const MELVIN = read('core/agents/melvin.md');
const fmOf = (md) => /^---\n([\s\S]*?)\n---\n/.exec(md)[1];
const modelOf = (md) => (/^model:\s*(.+)$/m.exec(fmOf(md)) || [])[1];
const toolsOf = (md) => {
  const m = /^tools:\s*(.+)$/m.exec(fmOf(md));
  return m ? m[1].replace(/^\[|\]$/g, '').split(',').map((t) => t.trim()) : null;
};
// A third-party persona that is security-tier only by its `security: true` flag.
const CUSTOM_SECURITY = '---\nname: warden\ndescription: custom security reviewer\nmodel: opus\nsecurity: true\nskills: []\n---\n\n# Warden\n';

describe('M1: models: cannot override the security tier', () => {
  test('accepts no models block, tier overrides, and the security model itself (positive control)', () => {
    assert.doesNotThrow(() => render.validateModelsConfig({}));
    assert.doesNotThrow(() => render.validateModelsConfig({ models: { opus: 'claude-opus-5-5', fast: 'claude-haiku-4-5' } }));
    assert.doesNotThrow(() => render.validateModelsConfig({ models: { security: 'claude-opus-4-8', nyx: 'claude-opus-4-8' } }));
  });

  for (const bad of ['gemini-4-argon', 'claude-opus-5-5', 'claude-opus-4.8', 'opus', '']) {
    test(`rejects models.security = '${bad}'`, () => {
      assert.throws(() => render.validateModelsConfig({ models: { security: bad } }), /models\.security .*claude-opus-4-8/);
      assert.throws(() => render.resolveModelTiers({ models: { security: bad } }, 'claude'), /models\.security/);
    });
  }

  test('rejects a key naming nyx (any case) or a security: true agent', () => {
    assert.throws(() => render.validateModelsConfig({ models: { nyx: 'claude-sonnet-5-5' } }), /models\.nyx/);
    assert.throws(() => render.validateModelsConfig({ models: { NYX: 'gemini-4-argon' } }), /models\.NYX/);
    assert.throws(() => render.validateModelsConfig({ models: { warden: 'gpt-6-astra' } }, ['nyx', 'warden']), /models\.warden/);
    assert.doesNotThrow(() => render.validateModelsConfig({ models: { warden: 'gpt-6-astra' } }, ['nyx']), 'positive control: a non-security agent name is not held');
  });

  test('render paths reject it too', () => {
    const cfg = { models: { security: 'gemini-4-argon' } };
    assert.throws(() => render.renderAgentForHarness(NYX, 'claude', cfg), /models\.security/);
    assert.throws(() => render.renderAgentForHarness(NYX, 'copilot', cfg), /models\.security/);
    assert.throws(() => render.renderAntigravityAgent(NYX, cfg), /models\.security/);
  });

  function installWith(modelsYaml, harness = 'claude') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engsys-model-policy-'));
    fs.writeFileSync(
      path.join(dir, 'engsys.config.yaml'),
      `project:\n  name: T\n  description: model policy\nharness: ${harness}\nstack:\n  lang: [typescript]\nissue_tracker: github\n${modelsYaml}`
    );
    return dir;
  }

  test('install rejects models.security other than claude-opus-4-8 and writes nothing', () => {
    for (const harness of ['claude', 'copilot', 'antigravity']) {
      const dir = installWith('models:\n  security: gemini-4-argon\n', harness);
      try {
        assert.throws(() => runInstall({ engsysRoot: ROOT, into: dir, mode: 'install' }), /models\.security .*claude-opus-4-8/, harness);
        assert.ok(!fs.existsSync(path.join(dir, '.claude')) && !fs.existsSync(path.join(dir, '.agents')), `${harness}: nothing installed`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('install rejects models.nyx', () => {
    const dir = installWith('models:\n  nyx: claude-sonnet-5-5\n');
    try {
      assert.throws(() => runInstall({ engsysRoot: ROOT, into: dir, mode: 'install' }), /models\.nyx/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('install with a judgement override succeeds and keeps nyx on claude-opus-4-8 (positive control)', () => {
    const dir = installWith('models:\n  opus: claude-opus-5-5\n');
    try {
      runInstall({ engsysRoot: ROOT, into: dir, mode: 'install' });
      const nyx = fs.readFileSync(path.join(dir, '.claude/agents/nyx.md'), 'utf8');
      const melvin = fs.readFileSync(path.join(dir, '.claude/agents/melvin.md'), 'utf8');
      assert.equal(modelOf(nyx), 'claude-opus-4-8');
      assert.equal(modelOf(melvin), 'claude-opus-5-5', 'the override did apply to the judgement tier');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('H6: the security tier never renders to another model', () => {
  test('Claude: nyx and security: true agents render claude-opus-4-8, even with other tiers overridden', () => {
    const cfg = { models: { opus: 'claude-opus-5-5', escalation: 'y', fast: 'z' } };
    assert.equal(modelOf(render.renderAgentForHarness(NYX, 'claude', cfg)), 'claude-opus-4-8');
    assert.equal(modelOf(render.renderAgentForHarness(CUSTOM_SECURITY, 'claude', cfg)), 'claude-opus-4-8');
    assert.equal(modelOf(render.renderAgentForHarness(MELVIN, 'claude', cfg)), 'claude-opus-5-5', 'positive control');
  });

  test("Copilot: security tier renders Copilot's ID for Claude Opus 4.8", () => {
    assert.equal(modelOf(render.renderAgentForHarness(NYX, 'copilot', {})), render.SECURITY_MODEL_BY_HARNESS.copilot);
    assert.equal(modelOf(render.renderAgentForHarness(CUSTOM_SECURITY, 'copilot', {})), 'claude-opus-4.8');
    assert.equal(render.resolveModelTiers({}, 'copilot').security, 'claude-opus-4.8');
  });

  test('Antigravity: security tier renders a refusal stub with no model', () => {
    for (const md of [NYX, CUSTOM_SECURITY]) {
      const out = render.renderAntigravityAgent(md, {});
      assert.equal(modelOf(out), undefined, 'no model: line at all');
      assert.doesNotMatch(out, /gemini/i);
      assert.match(fmOf(out), /^unsupported: true$/m);
      assert.match(fmOf(out), /^security: true$/m);
      assert.match(out, /STATUS: INCOMPLETE/);
      assert.match(out, /escalate/i);
      assert.match(out, /claude-opus-4-8/);
    }
    assert.equal(render.resolveModelTiers({}, 'antigravity').security, null);
  });

  test('Antigravity: non-security personas still map to Gemini (positive control)', () => {
    const out = render.renderAntigravityAgent(MELVIN, {});
    assert.equal(modelOf(out), 'gemini-4-argon');
    assert.doesNotMatch(out, /unsupported: true/);
  });

  test('Antigravity agent guide names the security tier unsupported, not a Gemini model', () => {
    const md = render.renderAgentsMd('# P — Claude Code working notes\n\n## Model strategy\n\nx\n\n## Worker providers\n', 'antigravity', {});
    const line = md.split('\n').find((l) => l.includes('**Security role**'));
    assert.ok(line, 'security line present');
    assert.match(line, /unsupported on Antigravity/);
    assert.doesNotMatch(line, /gemini/i);
  });

  test('scaffold fleet.conf: every harness block keeps SECURITY_MODEL and MAINTAIN_MODEL on claude-opus-4-8', () => {
    const conf = read('core/fleet/scaffold/fleet/fleet.conf');
    for (const h of ['claude', 'copilot', 'antigravity']) {
      const block = new RegExp(`\\{\\{#if harness_${h}\\}\\}([\\s\\S]*?)\\n\\{\\{/if\\}\\}\\n(?:\\{\\{#if harness_|\\{\\{#unless harness_claude|# Permission)`).exec(conf);
      assert.ok(block, `harness_${h} block`);
      assert.match(block[1], /^SECURITY_MODEL=claude-opus-4-8$/m, `${h} SECURITY_MODEL`);
      assert.match(block[1], /^MAINTAIN_MODEL=claude-opus-4-8$/m, `${h} MAINTAIN_MODEL`);
    }
    assert.doesNotMatch(conf, /^(SECURITY|MAINTAIN)_MODEL=(?!claude-opus-4-8$).*/m);
    // The merge monster model is Claude-only: no per-harness non-Claude MM_MODEL.
    for (const line of conf.split('\n').filter((l) => /^MM_MODEL=/.test(l))) assert.match(line, /^MM_MODEL=claude-/, line);
  });
});

describe('F4: security: true always renders the security tier', () => {
  const variants = ['security: true', 'security: True', 'security: "true"', "security: 'TRUE'", 'security: yes', 'Security: true', 'SECURITY: on', 'security: true # pinned'];
  for (const v of variants) {
    test(`'${v}' is security-tier, on Claude with no models: block too`, () => {
      const md = `---\nname: warden\ndescription: d\nmodel: opus\n${v}\nskills: []\n---\n\nbody\n`;
      assert.equal(render.isSecurityPersona(md), true);
      assert.equal(modelOf(render.renderAgentForHarness(md, 'claude', {})), 'claude-opus-4-8');
      assert.equal(modelOf(render.renderAgentForHarness(md, 'copilot', {})), 'claude-opus-4.8');
      assert.match(render.renderAntigravityAgent(md, {}), /^unsupported: true$/m);
    });
  }
  for (const v of ['security: false', 'security: no', 'security: "false"', 'insecurity: true']) {
    test(`'${v}' is not security-tier (positive control)`, () => {
      const md = `---\nname: w\ndescription: d\nmodel: opus\n${v}\n---\n\nbody\n`;
      assert.equal(render.isSecurityPersona(md), false);
      assert.equal(render.renderAgentForHarness(md, 'claude', {}), md, 'untouched on Claude with no models:');
    });
  }
  test('a security persona with no model: line gets the security model', () => {
    const md = '---\nname: w\ndescription: d\nsecurity: true\n---\n\nbody\n';
    assert.equal(modelOf(render.renderAgentForHarness(md, 'claude', {})), 'claude-opus-4-8');
  });
  test('nyx renders byte-identical on Claude with no models: block (already pinned)', () => {
    assert.equal(render.renderAgentForHarness(NYX, 'claude', {}), NYX);
  });
  test('lint: every shipped persona with security: true pins model: claude-opus-4-8', () => {
    const dirs = ['core/agents', 'optional-agents'];
    let seen = 0;
    for (const d of dirs) {
      for (const f of fs.readdirSync(path.join(ROOT, d)).filter((x) => x.endsWith('.md'))) {
        const md = read(`${d}/${f}`);
        if (!render.isSecurityPersona(md)) continue;
        seen++;
        assert.equal(modelOf(md), 'claude-opus-4-8', `${d}/${f}: security: true requires model: claude-opus-4-8`);
      }
    }
    assert.ok(seen >= 1, 'nyx is found as a security persona');
  });
  test('install: securityAgentNames honours YAML-boolean variants (models.<agent> held)', () => {
    assert.throws(() => render.validateModelsConfig({ models: { warden: 'x' } }, ['nyx', 'warden']), /models\.warden/);
  });
});

describe('M2: persona tool sets', () => {
  test('nyx has Bash, and no send-capable MCP tools (explicit allowlist)', () => {
    const tools = toolsOf(NYX);
    assert.ok(Array.isArray(tools), 'nyx declares an explicit tools: allowlist');
    assert.ok(tools.includes('Bash'), `nyx tools: ${tools}`);
    assert.deepEqual(tools, ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'WebFetch', 'WebSearch']);
    assert.ok(!tools.some((t) => t.startsWith('mcp__')), 'no MCP tools');
  });

  test('a persona with a tools: allowlist binds no MCP-driven skill it cannot call', () => {
    const MCP_SKILLS = ['chrome-devtools'];
    for (const d of ['core/agents', 'optional-agents']) {
      for (const f of fs.readdirSync(path.join(ROOT, d)).filter((x) => x.endsWith('.md'))) {
        const md = read(`${d}/${f}`);
        const tools = toolsOf(md);
        if (tools === null || tools.some((t) => t.startsWith('mcp__'))) continue;
        const skills = ((/^skills:\s*\[(.*)\]$/m.exec(fmOf(md)) || [])[1] || '').split(',').map((x) => x.trim());
        for (const sk of MCP_SKILLS) assert.ok(!skills.includes(sk), `${d}/${f} binds ${sk} but its tools: allowlist has no MCP tools`);
      }
    }
  });

  test('marcelo has Bash', () => {
    const tools = toolsOf(MARCELO);
    assert.ok(tools === null || tools.includes('Bash'), `marcelo tools: ${tools}`);
  });

  test('a read-only critic still lacks Bash (positive control for the parser)', () => {
    assert.deepEqual(toolsOf(MELVIN), ['Read', 'Grep', 'Glob', 'Write']);
  });

  test('rendering keeps the full tool set: Claude/Copilot add no tools line; Antigravity enables write tools', () => {
    for (const h of ['claude', 'copilot']) {
      assert.equal(toolsOf(render.renderAgentForHarness(MARCELO, h, { models: { opus: 'm' } })), null, h);
    }
    assert.match(render.renderAntigravityAgent(MARCELO, {}), /^enable_write_tools: true$/m);
    assert.match(render.renderAntigravityAgent(MELVIN, {}), /^enable_write_tools: false$/m, 'positive control');
  });
});
