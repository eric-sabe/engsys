#!/usr/bin/env bash
# scrub-env.sh — make a fleet test hermetic (sourced, not run). A test that runs inside a fleet session
# inherits that fleet's own configuration (ENGSYS_DIR, FLEET_*, PIN_*, the gh App env, the git identity
# config); the kit reads all of it, so a leaked variable silently changes what the test exercises (#45).
# Unset everything the kit reads before the test sets up its own sandbox.
_scrub_vars="$(compgen -v | grep -E '^(ENGSYS_|FLEET_|PIN_|INSTANCE_|GH_APP|GH_BOT_|GH_TOKEN$|GITHUB_TOKEN$|GIT_CONFIG_|BATON_|NOTIFY_|SLACK_|HEARTBEAT_)|^(ENGSYS|FLEET_INSTANCE|INSTANCE)$' || true)"
for _v in $_scrub_vars; do unset "$_v"; done
# A git hook exports these; a child `git init` would rewrite the enclosing repo.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY
unset _scrub_vars _v
