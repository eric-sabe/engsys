// is-main.mjs — "was this ESM file invoked directly as `node <this file>`?", symlink-safe.
//
// The common `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)` check compares a
// plain path normalization against Node's ESM loader output, which realpath-resolves symlinks for
// module identity. A script invoked via a symlinked path (a tmp dir under a symlink — /tmp on
// macOS is itself a symlink to /private/tmp — or a versioned/symlinked plugin-cache layout) then
// gets `import.meta.url` back pointing at the REAL path, the comparison silently fails, and the
// script's `if (isMain) { main() }` guard never runs: no crash, no error, just an exit 0 that did
// nothing — exactly the kind of silent failure a fail-open CLI must not have on its own entry point.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** True iff `metaUrl` (pass `import.meta.url`) names the script actually invoked (`process.argv[1]`). */
export function isMainEntry(metaUrl, argv = process.argv) {
	const invoked = argv[1];
	if (!invoked) return false;
	try {
		return realpathSync(invoked) === fileURLToPath(metaUrl);
	} catch {
		// `invoked` doesn't exist as a file (unusual, but not this check's job to diagnose) — fall
		// back to the plain comparison rather than silently reporting "not main".
		return invoked === fileURLToPath(metaUrl);
	}
}
