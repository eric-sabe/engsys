// agy.mjs — worker adapter for Google Antigravity CLI (#149).
import { checkAgyCli, runAgyCli } from './_agy-cli.mjs';

export const name = 'agy';
export const family = 'antigravity';

export function check() {
	return checkAgyCli();
}

export function run(opts) {
	return runAgyCli(opts);
}
