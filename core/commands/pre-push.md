---
description: Run the project's full local pre-push gate (build/lint/format/test plus any path-gated checks for migrations, IaC, and containers)
---

Run the project's pre-push gate / precheck per `CLAUDE.md` § Pre-push gate. **Don't push if any step fails** — fix locally first.

The exact gate commands are **defined by the project** (in `CLAUDE.md` and, where present, a `precheck`/`pre-push` task that the local pre-push hook runs). This command is the discipline; the project supplies the concrete commands.

1. **Identify touched paths** since `origin/main`:

   ```bash
   git diff --name-only origin/main...HEAD
   ```

2. **Always run the core gate** (mirrors CI) — the project's:
   - build / typecheck
   - lint
   - format check
   - unit tests

   Prefer the project's single precheck entrypoint if it has one (it is usually diff-driven and runs only the relevant gates).

3. **If database migrations were touched** — additionally build the data layer and apply the migration against a local database to confirm the SQL/schema applies cleanly.

4. **If infrastructure-as-code was touched** — run the project's IaC validation / synth / plan step (cloud-agnostic: whatever the active stack's skill pack defines).

5. **If a container build file was touched** — smoke-build the image. A build failure (missing COPY, bad layer) blocks the push; runtime env/DB errors when running the image are expected and OK.

Report green ✓ / red ✗ per step. If everything green, you're cleared to push.
