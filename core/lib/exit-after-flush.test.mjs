import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MOD = fileURLToPath(new URL('./exit-after-flush.mjs', import.meta.url));

test('a 4 MB write to a pipe followed by exitAfterFlush arrives whole, with the exit code (engsys#198)', () => {
  const script = `import { exitAfterFlush } from ${JSON.stringify(MOD)};
    process.stdout.write('x'.repeat(4 * 1024 * 1024) + '\\nEND\\n');
    exitAfterFlush(3);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { maxBuffer: 16 * 1024 * 1024 });
  assert.equal(r.status, 3);
  assert.equal(r.stdout.length, 4 * 1024 * 1024 + 5);
  assert.ok(r.stdout.toString().endsWith('END\n'));
});
