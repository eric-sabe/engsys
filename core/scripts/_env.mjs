// _env.mjs — load provider credentials from .env files so keys never need to
// live in shell profiles (a profile leaks into every process the user ever
// starts; a gitignored .env is scoped to the machine and the repo).
//
// Resolution order — first definition of a name wins, and a variable already
// present in the real environment ALWAYS wins over any file (explicit beats
// implicit):
//
//   1. $ENGSYS_ENV_FILE            explicit override, any path
//   2. <cwd>/.env                  the project (or worktree) being dispatched
//   3. <main checkout>/.env        when cwd is a linked git worktree — this is
//                                  load-bearing: worktrees do NOT share
//                                  untracked files, so without this hop every
//                                  worktree dispatch would silently miss the
//                                  keys that sit in the main checkout's .env
//   4. ~/.config/engsys/env        machine-wide, outside any repo
//
// Same pattern as the repo dashboard's .env / .env.example: the file is
// gitignored, the example documents the names.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

function parseEnv(text) {
	const out = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
		if (!m) continue;
		let v = m[2].trim();
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
		out[m[1]] = v;
	}
	return out;
}

function gitMainRoot(cwd) {
	try {
		const common = execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim();
		if (common && /[/\\]\.git$/.test(common)) return dirname(common);
	} catch {
		/* not a git repo — fine */
	}
	return null;
}

export function loadWorkerEnv(cwd = process.cwd()) {
	const candidates = [];
	if (process.env.ENGSYS_ENV_FILE) candidates.push(resolve(process.env.ENGSYS_ENV_FILE));
	candidates.push(join(resolve(cwd), '.env'));
	const main = gitMainRoot(cwd);
	if (main) candidates.push(join(main, '.env'));
	candidates.push(join(homedir(), '.config', 'engsys', 'env'));

	const loaded = [];
	const seen = new Set();
	for (const file of candidates) {
		if (seen.has(file) || !existsSync(file)) continue;
		seen.add(file);
		let applied = 0;
		for (const [k, v] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
			if (process.env[k] === undefined) {
				process.env[k] = v;
				applied++;
			}
		}
		loaded.push({ file, applied });
		// A committed .env is keys published to every clone. The loader is the
		// one place guaranteed to see the file, so the alarm lives here.
		try {
			execFileSync('git', ['-C', dirname(file), 'ls-files', '--error-unmatch', '--', file], { stdio: 'ignore' });
			console.error(
				`worker-env: WARNING — ${file} is TRACKED BY GIT. A committed .env publishes its keys to every clone; gitignore it and rotate anything it holds.`,
			);
		} catch {
			/* untracked or not in a repo — the good case */
		}
	}
	if (loaded.length) {
		console.log(`worker-env: ${loaded.map((l) => `${l.file} (+${l.applied})`).join(', ')}`);
	}
	return loaded;
}
