#!/usr/bin/env node
// host-toolchain.mjs — detects host OS, userland dialect (BSD vs GNU vs Windows), bash version
// caveats, and non-login PATH gaps (/opt/homebrew/bin, /usr/local/bin, ~/.local/bin, etc.).
//
// Injected as a concise 1-line note at SessionStart (via engsys-context.mjs) so agents running inside
// GUI/IDE harnesses (Antigravity, VS Code), non-login subshells, or launchd/systemd environments know:
//   1. Which userland flags to use (BSD sed/grep/stat/date/shasum on macOS vs GNU on Linux/WSL2).
//   2. Whether /bin/bash is legacy 3.2 (macOS) vs Bash 5+ (/opt/homebrew/bin/bash).
//   3. Which package-manager bin directories exist on disk but are missing from the current PATH.
//
// Zero dependencies; pure filesystem checks (no subprocess spawns) so SessionStart stays < 5ms.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Inspect the host OS, architecture, userland, and standard toolchain directories.
 */
export function detectHostToolchain(
  env = process.env,
  {
    platform = process.platform,
    arch = process.arch,
    nodeVersion = process.version,
    existsSync = fs.existsSync,
  } = {},
) {
  const home = env.HOME || env.USERPROFILE || '';
  const isWsl =
    platform === 'linux' &&
    Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP || (existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')));

  let osLabel = platform;
  let userland = 'POSIX';
  if (platform === 'darwin') {
    osLabel = 'macOS';
    userland = 'BSD';
  } else if (isWsl) {
    osLabel = 'Linux (WSL2)';
    userland = 'GNU';
  } else if (platform === 'linux') {
    osLabel = 'Linux';
    userland = 'GNU';
  } else if (platform === 'win32') {
    osLabel = 'Windows';
    userland = 'Windows/MSYS';
  }

  // Candidate bin directories by OS where developer & fleet CLI tools live
  const candidateBinDirs = [];
  if (platform === 'darwin') {
    candidateBinDirs.push('/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin');
  } else if (platform === 'linux') {
    candidateBinDirs.push('/home/linuxbrew/.linuxbrew/bin', '/usr/local/bin');
  }
  if (home) {
    candidateBinDirs.push(path.join(home, '.local', 'bin'), path.join(home, '.cargo', 'bin'));
  }

  const pathDelimiter = platform === 'win32' ? ';' : ':';
  const currentPathSet = new Set(
    String(env.PATH || '')
      .split(pathDelimiter)
      .map((p) => p.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  );

  const presentBinDirs = [];
  const missingFromPath = [];
  for (const dir of candidateBinDirs) {
    const clean = dir.replace(/\/+$/, '');
    let exists = false;
    try {
      exists = Boolean(existsSync(clean));
    } catch {
      exists = false;
    }
    if (exists) {
      presentBinDirs.push(clean);
      if (!currentPathSet.has(clean)) {
        missingFromPath.push(clean);
      }
    }
  }

  // Check if modern Homebrew bash exists on macOS (where /bin/bash is stuck at GPLv2 3.2)
  let brewBash = null;
  if (platform === 'darwin') {
    for (const candidate of ['/opt/homebrew/bin/bash', '/usr/local/bin/bash']) {
      try {
        if (existsSync(candidate)) {
          brewBash = candidate;
          break;
        }
      } catch { /* ignore */ }
    }
  }

  return {
    platform,
    arch,
    osLabel,
    userland,
    isWsl,
    nodeVersion,
    brewBash,
    presentBinDirs,
    missingFromPath,
  };
}

/**
 * Render a single concise instruction line for SessionStart context injection.
 */
export function contextLine(env = process.env, opts = {}) {
  const info = detectHostToolchain(env, opts);
  const parts = [];

  if (info.platform === 'darwin') {
    const bashPart = info.brewBash
      ? `/bin/bash is 3.2, Bash 5+ at ${info.brewBash}`
      : `/bin/bash is 3.2 (no mapfile/declare -A/\${var,,})`;
    parts.push(`${info.osLabel} ${info.arch} (${info.userland} userland; ${bashPart}; Node ${info.nodeVersion})`);
    if (info.missingFromPath.length > 0) {
      const prepend = info.missingFromPath.join(':');
      parts.push(
        `non-login subshells omit ${prepend} from PATH — prepend PATH="${prepend}:$PATH" when invoking node/pnpm/gh/jq/cr/grok/codex/copilot/agy`,
      );
    } else if (info.presentBinDirs.length > 0) {
      parts.push(
        `if a non-login subshell or launchd job misses CLI tools, ensure ${info.presentBinDirs.slice(0, 2).join(':')} is on PATH`,
      );
    }
    parts.push(
      `use BSD flags (sed -i '', stat -f, date -r/-v, shasum -a 256; avoid grep -E empty subexpressions like (a|) and GNU-only sed/stat/date flags)`,
    );
  } else if (info.platform === 'linux') {
    parts.push(`${info.osLabel} ${info.arch} (${info.userland} userland; /bin/sh is often dash — invoke bash explicitly for [[ ]]/pipefail/arrays; Node ${info.nodeVersion})`);
    if (info.missingFromPath.length > 0) {
      const prepend = info.missingFromPath.join(':');
      parts.push(`non-login subshells omit ${prepend} from PATH — prepend PATH="${prepend}:$PATH" when needed`);
    }
  } else {
    parts.push(`${info.osLabel} ${info.arch} (${info.userland}; Node ${info.nodeVersion})`);
  }

  return `Host toolchain: ${parts.join(' — ')}.`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] || 'context-line';
  if (mode === '--json' || mode === 'json') {
    process.stdout.write(`${JSON.stringify(detectHostToolchain(process.env), null, 2)}\n`);
  } else {
    process.stdout.write(`${contextLine(process.env)}\n`);
  }
}
