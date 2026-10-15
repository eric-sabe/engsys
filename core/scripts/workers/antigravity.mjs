// antigravity.mjs — worker adapter alias for Google Antigravity CLI (#149).
import { checkAgyCli, runAgyCli } from './_agy-cli.mjs';

export const name = 'antigravity';
export const family = 'antigravity';

export function check() {
	return checkAgyCli();
}

export function run(opts) {
	return runAgyCli(opts);
}
