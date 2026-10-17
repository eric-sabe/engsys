// monster-skill-rules.test.mjs — the monster skills keep every rule in their always-loaded SKILL.md.
//
// references/*.md files are optional reads and are not re-read on their own after a compaction, so a
// rule that lives only there is a rule a long-running monster can lose. The fixture lists the
// canonical v1.16.0 rules (the full Hard rules list plus the other rules that must stay always
// loaded); each must appear, after normalization, in the current SKILL.md.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/monster-skill-rules.json'), 'utf8'));
const SKILLS = ['merge-monster', 'maintenance-monster'];

/** Markdown-insensitive comparison form: no emphasis/code marks, one space, straight quotes, lowercase. */
export function normalize(text) {
  return text
    .replace(/[*`]/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const skillText = (skill) => read(`core/skills/${skill}/SKILL.md`);

describe('monster SKILL.md carries every rule (no rule lives only in references/)', () => {
  test('normalize is markdown- and whitespace-insensitive (positive control)', () => {
    assert.equal(normalize('Never `--force`\n  (lease **only**)'), 'never --force (lease only)');
    assert.ok(normalize('a  “b” c').includes(normalize('A "b" C')));
  });

  for (const skill of SKILLS) {
    const spec = FIXTURE[skill];

    test(`${skill}: fixture is non-trivial`, () => {
      assert.ok(spec.hard_rules.length >= 15, 'fixture must list the full v1.16.0 hard-rules set');
      assert.ok(spec.always_loaded.length >= 5);
    });

    test(`${skill}: every v1.16.0 hard rule appears in SKILL.md`, () => {
      const body = normalize(skillText(skill));
      const missing = spec.hard_rules.filter((rule) => !body.includes(normalize(rule)));
      assert.deepEqual(missing, [], `${skill}/SKILL.md lost hard rules`);
    });

    test(`${skill}: every always-loaded rule appears in SKILL.md`, () => {
      const body = normalize(skillText(skill));
      const missing = spec.always_loaded.filter((rule) => !body.includes(normalize(rule)));
      assert.deepEqual(missing, [], `${skill}/SKILL.md lost always-loaded rules`);
    });

    test(`${skill}: a SKILL.md with a rule removed fails the check (negative control)`, () => {
      const rule = spec.hard_rules[3];
      const gutted = normalize(skillText(skill)).split(normalize(rule)).join('');
      const missing = spec.hard_rules.filter((r) => !gutted.includes(normalize(r)));
      assert.ok(missing.includes(rule), 'the check must flag a removed rule');
    });

    test(`${skill}: every "read <reference> § X" pointer names a real section`, () => {
      const text = skillText(skill);
      const ref = read(`core/skills/${skill}/${spec.reference}`);
      const headings = new Set(
        ref.split('\n').filter((l) => /^## /.test(l)).map((l) => normalize(l.slice(3)))
      );
      const alias = spec.reference_alias.replace(/ /g, '\\s+');
      const re = new RegExp(`read\\s+${alias}\\s+§\\s+([^.,;(\\n]+?)(?:\\s+first|\\s+before|\\s+for|\\s*\\(|[.,;]|$)`, 'gim');
      const pointers = [...text.matchAll(re)].map((m) => m[1].trim());
      assert.ok(pointers.length >= 3, `${skill}/SKILL.md must point at specific reference sections before the events that need them`);
      for (const p of pointers) {
        const hit = [...headings].some((h) => h.startsWith(normalize(p)));
        assert.ok(hit, `${skill}/SKILL.md points at "${spec.reference} § ${p}", which is not a heading there`);
      }
      assert.ok(text.includes(spec.reference), `${skill}/SKILL.md must name ${spec.reference}`);
    });

    test(`${skill}: context discipline re-reads SKILL.md and its references`, () => {
      const body = normalize(skillText(skill));
      assert.ok(body.includes(normalize(`re-read this SKILL.md and ${spec.reference}`)));
    });
  }

  test('reground templates (compact, clear) re-read SKILL.md and the references it names', () => {
    for (const t of ['post-compact-reground.sh.tmpl', 'post-clear-reground.sh.tmpl']) {
      const body = read(`core/templates/${t}`);
      for (const skill of SKILLS) {
        assert.ok(body.includes(FIXTURE[skill].reference), `${t} must name ${skill}'s ${FIXTURE[skill].reference}`);
      }
      assert.match(body, /SKILL\.md[^\n]*references\/\*\.md/, `${t} must re-read references alongside SKILL.md`);
    }
  });

  test('merge-monster: SDD contract check is opt-in, off by default', () => {
    const text = skillText('merge-monster');
    assert.match(text, /contract-check\.mjs[^\n]*is opt-in and off by default/);
    // Every mention of the flag is conditional on the config opt-in.
    for (const line of text.split('\n').filter((l) => l.includes('--check-contract'))) {
      assert.match(line, /only when the config sets `ready_requirements\.sdd_contract: true`/, line);
    }
    const cfg = read('core/skills/merge-monster/config.example.yml');
    assert.match(cfg, /^\s+sdd_contract: false\b/m, 'config example must default sdd_contract to false');
  });
});
