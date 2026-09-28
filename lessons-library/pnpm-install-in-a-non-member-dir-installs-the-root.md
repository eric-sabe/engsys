# pnpm: installing in a directory that is not a workspace member installs the root

**Stack:** pnpm workspaces. Skip if the project does not use them.

**Trigger:** A package directory inside the repo has its own `package.json` but is not listed in `pnpm-workspace.yaml` (a standalone script or tool), and `pnpm install` there (locally, or a CI step with a working directory) prints `Scope: all N workspace projects`, exits 0, and the package's own dependencies are still missing (`Cannot find module` from `tsc` or a runner). Nastier variant: it "worked for months", then went red on a merge that only touched other packages' dependencies.

**Failure mode:**
- pnpm walks up from the cwd to find the workspace file, finds the repo root, and installs the root workspace, not the non-member. Its `package.json` is never an importer, so its deps are never resolved, with no error.
- With hoisting enabled, every workspace dependency is hoisted into the root `node_modules`, and Node resolves upward, so the tool silently borrows whatever another member declares. When that member drops the dependency, the tool breaks. Its own dependency declaration was decorative all along.
- `--ignore-workspace` works but writes a second lockfile nobody commits or freezes, so CI resolves fresh against the live registry each run.

**Correct behavior:**
- Make the package a workspace member, regenerate the root lockfile, and install in CI from the root with the lockfile frozen: `pnpm install --frozen-lockfile --filter <pkg-name>`. Give it a `build` (type-check) script so root gates cover it.
- Register a new non-container member in any per-package CI/deploy allowlists or denylists in the same change (the token is often the package name, which can differ from the directory name).
- Delete any stray nested lockfile: exactly one lockfile.

**Check:** The install step's scope line names the package (not "all N workspace projects"), the dependency exists under `<dir>/node_modules`, and type-checking passes.

**Seen in:** recurring in monorepos with standalone tooling directories.
