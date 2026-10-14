// security-model.test.mjs — the nyx agent's frontmatter pin and the `fleet init` SECURITY_MODEL default
// move together (engsys#118). Run by `npm test`.
//
// A subagent whose frontmatter says `model: opus` runs the parent session's exact Opus model;
// ANTHROPIC_DEFAULT_OPUS_MODEL does not re-point it. A per-call `model:` on the Agent tool takes only
// tier aliases. So a full model ID in nyx's frontmatter is the one reliable pin for the security lane,
// and it must name the same model the scaffold's security lane does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The `model:` value in an agent file's YAML frontmatter, or null. */
function frontmatterModel(file) {
  const m = /^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(file, 'utf8'));
  if (!m) return null;
  const line = m[1].split('\n').find((l) => /^model:/.test(l));
  return line ? line.slice('model:'.length).trim().replace(/^(['"])(.*)\1$/, '$2') : null;
}

/** The SECURITY_MODEL default the `fleet init` scaffold writes into fleet/fleet.conf. */
function securityModelDefault() {
  const conf = fs.readFileSync(path.join(ROOT, 'core/fleet/scaffold/fleet/fleet.conf'), 'utf8');
  const lines = conf.split('\n').filter((l) => /^SECURITY_MODEL=/.test(l));
  assert.equal(lines.length, 1, 'fleet.conf sets SECURITY_MODEL exactly once');
  return lines[0].slice('SECURITY_MODEL='.length).trim();
}

test('nyx frontmatter pins the fleet init SECURITY_MODEL default', () => {
  const pinned = frontmatterModel(path.join(ROOT, 'core/agents/nyx.md'));
  const security = securityModelDefault();
  assert.match(security, /^claude-[a-z0-9-]+$/, 'SECURITY_MODEL is a full model ID');
  assert.equal(pinned, security, 'core/agents/nyx.md `model:` must equal SECURITY_MODEL in core/fleet/scaffold/fleet/fleet.conf');
});

test('nyx is pinned by full model ID, never a tier alias', () => {
  const pinned = frontmatterModel(path.join(ROOT, 'core/agents/nyx.md'));
  assert.ok(!['opus', 'sonnet', 'haiku', 'fable', 'inherit'].includes(pinned), `nyx model is an alias: ${pinned}`);
});
