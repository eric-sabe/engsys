#!/usr/bin/env bash
# Stack-pack post-edit reminder (db/prisma). Called by .claude/hooks/post-edit-reminders.sh
# with the edited file path as $1, only when no project hook_pattern matched it.
# Print a short nudge to stdout; print nothing when the path is not ours.
case "${1:-}" in
  *.prisma)
    echo "↳ Prisma schema changed — run \`prisma generate\` and build the database package, then rebuild the services that depend on it. Migrations to shared envs run in CI only, never from a laptop; keep the migration backward-compatible."
    ;;
esac
exit 0
