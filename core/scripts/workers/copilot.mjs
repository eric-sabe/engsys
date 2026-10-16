// copilot.mjs — worker adapter for GitHub Copilot CLI (#149).
import { checkCopilotCli, runCopilotCli } from './_copilot-cli.mjs';

export const name = 'copilot';
export const family = 'copilot';

export function check() {
	return checkCopilotCli();
}

export function run(opts) {
	return runCopilotCli(opts);
}
