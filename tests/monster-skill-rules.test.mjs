// monster-skill-rules.test.mjs — the monster skills keep every rule in their always-loaded SKILL.md.
//
// references/*.md files are optional reads and are not re-read on their own after a compaction, so a
// rule that lives only there is a rule a long-running monster can lose. The test diffs every rule
// unit of the frozen v1.16.0 SKILL.md (tests/fixtures/v1.16.0/) against the current one: each must
// appear in the current SKILL.md, or be listed in the reviewed fixture as moved to references (and
// still be there verbatim) or deliberately superseded. The fixture also lists the full v1.16.0
// hard-rules lists and the reworded rules that must stay in SKILL.md.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allSentences, normalize, ruleUnits } from './lib/rule-units.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/monster-skill-rules.json'), 'utf8'));
const SKILLS = ['merge-monster', 'maintenance-monster'];

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
      assert.ok(spec.reworded_required.length >= 5);
    });

    test(`${skill}: every v1.16.0 hard rule appears in SKILL.md`, () => {
      const body = normalize(skillText(skill));
      const missing = spec.hard_rules.filter((rule) => !body.includes(normalize(rule)));
      assert.deepEqual(missing, [], `${skill}/SKILL.md lost hard rules`);
    });

    test(`${skill}: every reworded rule that must stay always-loaded appears in SKILL.md`, () => {
      const body = normalize(skillText(skill));
      const missing = spec.reworded_required.filter((rule) => !body.includes(normalize(rule)));
      assert.deepEqual(missing, [], `${skill}/SKILL.md lost always-loaded rules`);
    });

    test(`${skill}: every v1.16.0 rule unit is in SKILL.md or explicitly reviewed as moved/superseded`, () => {
      const baseline = ruleUnits(read(spec.baseline));
      assert.ok(baseline.length > 100, 'the unit extractor found the baseline rules');
      const body = normalize(skillText(skill));
      const ref = normalize(read(`core/skills/${skill}/${spec.reference}`));
      const moved = new Map(spec.moved_to_references_ok.map((e) => [e.unit, e]));
      const superseded = new Map(spec.superseded_ok.map((e) => [e.unit, e]));
      const unaccounted = baseline.filter((u) => !body.includes(u) && !moved.has(u) && !superseded.has(u));
      assert.deepEqual(unaccounted, [], `${skill}: v1.16.0 rules missing from SKILL.md with no reviewed entry`);
      for (const [u, e] of moved) {
        assert.ok(e.reason && e.reason.length > 20, `moved entry needs a reason: ${u}`);
        assert.ok(ref.includes(u), `${skill}: rule listed as moved is no longer in ${spec.reference}: ${u}`);
      }
      for (const [u, e] of superseded) assert.ok(e.reason && e.reason.length > 20, `superseded entry needs a reason: ${u}`);
      // No stale entries: every listed unit is a baseline unit that is actually absent from SKILL.md.
      const base = new Set(baseline);
      for (const u of [...moved.keys(), ...superseded.keys()]) {
        assert.ok(base.has(u), `fixture lists a unit that is not in the v1.16.0 baseline: ${u}`);
        assert.ok(!body.includes(u), `fixture lists a unit that SKILL.md carries again; drop it from the list: ${u}`);
      }
    });

    test(`${skill}: every v1.16.0 sentence with once/only/exactly/at most is a checked rule unit`, () => {
      const text = read(spec.baseline);
      const units = new Set(ruleUnits(text));
      const quantified = allSentences(text).filter((x) => x.length >= 12 && /\b(once|only|exactly|at most)\b/.test(x));
      assert.ok(quantified.length > 20, 'the baseline has quantified rules');
      assert.deepEqual(quantified.filter((x) => !units.has(x)), [], 'quantified sentences the extractor drops');
      const all = [...units].join('\n');
      assert.match(all, /escalate[^\n]*once/, 'an "escalate … once" rule is checked');
      if (skill === 'merge-monster') assert.match(all, /nudge[^\n]*once/, 'a "nudge … once" rule is checked');
      if (skill === 'maintenance-monster') assert.match(all, /escalate once per policy/, 'the TRIPWIRE_FAILED once-per-policy rule is checked');
    });

    test(`${skill}: dropping a carried rule from SKILL.md is caught (negative control)`, () => {
      const baseline = ruleUnits(read(spec.baseline));
      const body = normalize(skillText(skill));
      const carried = baseline.find((u) => body.includes(u));
      assert.ok(carried, 'at least one v1.16.0 unit is carried verbatim');
      const gutted = body.split(carried).join('');
      const listed = new Set([...spec.moved_to_references_ok, ...spec.superseded_ok].map((e) => e.unit));
      assert.ok(!gutted.includes(carried) && !listed.has(carried));
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

  test('reground surfaces (compact/clear hooks, /fleet-prime, CLAUDE.md template) re-read SKILL.md and the references it names', () => {
    for (const t of ['core/templates/post-compact-reground.sh.tmpl', 'core/templates/post-clear-reground.sh.tmpl', 'core/commands/fleet-prime.md', 'core/templates/CLAUDE.md.tmpl']) {
      const body = read(t).replace(/`/g, '');
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
