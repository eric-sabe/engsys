import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectHostToolchain, contextLine } from './host-toolchain.mjs';

describe('host-toolchain', () => {
  it('detects macOS arm64 BSD userland, Homebrew bash, and missing non-login PATH dirs', () => {
    const existing = new Set(['/opt/homebrew/bin', '/opt/homebrew/bin/bash', '/Users/dev/.local/bin']);
    const env = {
      HOME: '/Users/dev',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    };
    const info = detectHostToolchain(env, {
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: 'v22.22.1',
      existsSync: (p) => existing.has(p),
    });

    assert.equal(info.osLabel, 'macOS');
    assert.equal(info.userland, 'BSD');
    assert.equal(info.brewBash, '/opt/homebrew/bin/bash');
    assert.deepEqual(info.missingFromPath, ['/opt/homebrew/bin', '/Users/dev/.local/bin']);

    const line = contextLine(env, {
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: 'v22.22.1',
      existsSync: (p) => existing.has(p),
    });
    assert.match(line, /Host toolchain: macOS arm64 \(BSD userland; \/bin\/bash is 3\.2, Bash 5\+ at \/opt\/homebrew\/bin\/bash; Node v22\.22\.1\)/);
    assert.match(line, /non-login subshells omit \/opt\/homebrew\/bin:\/Users\/dev\/\.local\/bin from PATH/);
    assert.match(line, /use BSD flags \(sed -i '', stat -f, date -r\/-v, shasum -a 256/);
  });

  it('notes present bin dirs on macOS when PATH already includes them', () => {
    const existing = new Set(['/opt/homebrew/bin', '/opt/homebrew/bin/bash', '/Users/dev/.local/bin']);
    const env = {
      HOME: '/Users/dev',
      PATH: '/opt/homebrew/bin:/Users/dev/.local/bin:/usr/bin:/bin',
    };
    const line = contextLine(env, {
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: 'v22.22.1',
      existsSync: (p) => existing.has(p),
    });
    assert.equal(
      detectHostToolchain(env, {
        platform: 'darwin',
        arch: 'arm64',
        nodeVersion: 'v22.22.1',
        existsSync: (p) => existing.has(p),
      }).missingFromPath.length,
      0,
    );
    assert.match(line, /if a non-login subshell or launchd job misses CLI tools, ensure \/opt\/homebrew\/bin:\/Users\/dev\/\.local\/bin is on PATH/);
  });

  it('detects Linux and WSL2 GNU userland', () => {
    const existing = new Set(['/home/linuxbrew/.linuxbrew/bin', '/home/dev/.local/bin']);
    const env = {
      HOME: '/home/dev',
      WSL_DISTRO_NAME: 'Ubuntu',
      PATH: '/usr/bin:/bin',
    };
    const info = detectHostToolchain(env, {
      platform: 'linux',
      arch: 'x64',
      nodeVersion: 'v22.12.0',
      existsSync: (p) => existing.has(p),
    });
    assert.equal(info.osLabel, 'Linux (WSL2)');
    assert.equal(info.userland, 'GNU');
    assert.equal(info.isWsl, true);
    assert.deepEqual(info.missingFromPath, ['/home/linuxbrew/.linuxbrew/bin', '/home/dev/.local/bin']);

    const line = contextLine(env, {
      platform: 'linux',
      arch: 'x64',
      nodeVersion: 'v22.12.0',
      existsSync: (p) => existing.has(p),
    });
    assert.match(line, /Linux \(WSL2\) x64 \(GNU userland; \/bin\/sh is often dash/);
    assert.match(line, /non-login subshells omit \/home\/linuxbrew\/\.linuxbrew\/bin:\/home\/dev\/\.local\/bin from PATH/);
  });
});
