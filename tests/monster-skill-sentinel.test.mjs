// monster-skill-sentinel.test.mjs — engsys#211: a monster session detects a SKILL.md body that never reached its
// context (the Skill tool answered "already loaded above" after the slash command) and re-reads it by path.
//
// The self-check lives in the slash command, the only text certain to be in context. Each SKILL.md carries a
// sentinel line under its title; the command names the line's shape but never the full token, so seeing the
// command can't stand in for seeing the body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MONSTERS = ['merge-monster', 'maintenance-monster', 'resource-broker'];
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

for (const skill of MONSTERS) {
  const body = read(`core/skills/${skill}/SKILL.md`);
  const command = read(`core/commands/${skill}.md`);
  const sentinel = body.match(new RegExp(`^body-sentinel:${skill}:([0-9a-f]{4})$`, 'm'));

  test(`${skill}: SKILL.md carries one sentinel line right under its title`, () => {
    assert.ok(sentinel, 'a line body-sentinel:<skill>:<4 hex> exists');
    assert.equal(body.match(/^body-sentinel:/gm).length, 1);
    const lines = body.split('\n');
    const h1 = lines.findIndex((l) => l.startsWith('# '));
    assert.ok(h1 >= 0 && lines.slice(h1 + 1, h1 + 4).includes(sentinel[0]), 'within three lines of the H1, so the first screen shows it');
  });

  test(`${skill}: the command runs the self-check and names the sentinel's shape, not its token`, () => {
    assert.match(command, new RegExp(`body-sentinel:${skill}:\` followed by four hex digits`));
    assert.match(command, /Read `<engsys-root>\/skills\/[a-z-]+\/SKILL\.md` by its literal path/);
    assert.match(command, /session-start digest/);
    assert.ok(!command.includes(sentinel[0]), 'the command must not contain the full sentinel line');
    assert.ok(!command.includes(sentinel[1]), 'nor its token');
    assert.match(command, /right after the Skill call returns/, 'the check runs after the skill call, when a missing body is real');
    assert.doesNotMatch(command, /before step 1/);
    const selfCheck = command.indexOf('Self-check, right after');
    assert.ok(selfCheck > 0 && selfCheck < command.indexOf('Before starting the loop'), 'the self-check runs before the startup steps');
  });

  test(`${skill}: the startup digest step says to record a re-read`, () => {
    assert.match(body, /re-read this file because its `body-sentinel` line was missing[^.]*say so in that digest/);
  });

  test(`${skill}: startup resolves plugin paths from the running session, not state.md (engsys#212)`, () => {
    assert.match(body, /never from a path recorded in `state\.md`/);
  });
}

test('merge and maintenance skills state the fenced-write body forms the guard accepts (engsys#212)', () => {
  for (const skill of MONSTERS) {
    assert.match(read(`core/skills/${skill}/SKILL.md`), /a literal body, or `--body-file -` with a heredoc whose delimiter is quoted/, skill);
  }
});

test('sentinel tokens are distinct per skill', () => {
  const tokens = MONSTERS.map((s) => read(`core/skills/${s}/SKILL.md`).match(/^body-sentinel:[a-z-]+:([0-9a-f]{4})$/m)[1]);
  assert.equal(new Set(tokens).size, MONSTERS.length);
});
