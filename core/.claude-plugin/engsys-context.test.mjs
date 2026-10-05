// engsys-context.test.mjs — the SessionStart context hook: the operator time line is present only
// when the fleet sets a time format, and the compaction/clear re-ground hooks carry the same line.
// Run: node --test core/.claude-plugin/engsys-context.test.mjs (part of `npm test`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(ROOT, '.claude-plugin', 'engsys-context.mjs');
const base = { PATH: process.env.PATH, CLAUDE_PLUGIN_ROOT: ROOT };

const context = (env) => JSON.parse(execFileSync(process.execPath, [HOOK], { env: { ...base, ...env }, encoding: 'utf8' })).hookSpecificOutput.additionalContext;
const reground = (tmpl, env) => execFileSync('bash', [path.join(ROOT, 'templates', tmpl)], { env: { ...base, ...env }, encoding: 'utf8' });

const ET = { OPERATOR_TIMEZONE: 'America/New_York', OPERATOR_CLOCK: '12h' };
const LINE = /Show dates and times to the operator in America\/New_York with a 12-hour clock \(\d{1,2}:\d{2} [AP]M ET\)\. Keep machine fields in UTC\./;

test('session start: no setting, no time line', () => {
  assert.doesNotMatch(context({}), /Show dates and times to the operator/);
});

test('session start: the setting adds one line, after the conventions', () => {
  const c = context(ET);
  assert.match(c, LINE);
  assert.equal(c.match(/Show dates and times to the operator/g).length, 1);
  assert.match(c.split('\n').at(-2), /Show dates and times/, 'the line closes the context');
});

test('session start: an invalid zone falls back to UTC in the line', () => {
  assert.match(context({ OPERATOR_TIMEZONE: 'Nope/Zone' }), /operator in UTC with a 24-hour clock/);
});

test('compaction and clear re-ground hooks carry the same line, and only with a setting', () => {
  for (const t of ['post-compact-reground.sh.tmpl', 'post-clear-reground.sh.tmpl']) {
    assert.match(reground(t, ET), LINE, t);
    assert.doesNotMatch(reground(t, {}), /Show dates and times/, t);
  }
});
