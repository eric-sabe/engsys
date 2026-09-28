#!/usr/bin/env bash
# fleet-context.sh — SessionStart hook: give a fleet session its per-repo context.
#
# Maps the session repo's `origin` remote to this plugin's repos/<owner>/<repo>/ directory and injects:
#   fleet config dir: <that directory>     (where the monsters find merge-monster.yml etc.)
#   the directory's context.md             (the fleet protocol for that repo)
#   context/org.md                         (org-wide: bot identity, escalation, model policy)
# A repo without a directory still gets org.md. Always exits 0 and never blocks the session (fail-open):
# missing files, no git, no remote and no jq are all just less context.
set -u

ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd -P)}"
[ -d "${ROOT:-}" ] || exit 0

# The session's working directory arrives as JSON on stdin ({"cwd": ...}); fall back to the project dir.
input=""
[ -t 0 ] || input="$(cat 2>/dev/null || true)"
cwd=""
if [ -n "$input" ] && command -v jq >/dev/null 2>&1; then
  cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)"
fi
cwd="${cwd:-${CLAUDE_PROJECT_DIR:-$PWD}}"

# owner/repo from the origin URL: https://host/owner/repo(.git), ssh://git@host/owner/repo, git@host:owner/repo
slug=""
url="$(git -C "$cwd" remote get-url origin 2>/dev/null || true)"
if [ -n "$url" ]; then
  slug="$(printf '%s' "$url" | sed -E 's#\.git/?$##; s#/+$##; s#^.*[:/]([^:/]+/[^:/]+)$#\1#')"
  case "$slug" in */*) ;; *) slug="" ;; esac
fi

# The directory name may differ in case from the slug GitHub reports; try the slug as given, then lowercase.
dir=""
if [ -n "$slug" ]; then
  lower="$(printf '%s' "$slug" | tr '[:upper:]' '[:lower:]')"
  for cand in "$slug" "$lower"; do
    if [ -d "$ROOT/repos/$cand" ]; then dir="$ROOT/repos/$cand"; break; fi
  done
fi

ctx=""
if [ -n "$dir" ]; then
  ctx="fleet config dir: $dir"
  if [ -f "$dir/context.md" ]; then ctx="$ctx

$(cat "$dir/context.md")"; fi
fi
if [ -f "$ROOT/context/org.md" ]; then
  if [ -n "$ctx" ]; then ctx="$ctx

$(cat "$ROOT/context/org.md")"; else ctx="$(cat "$ROOT/context/org.md")"; fi
fi
[ -n "$ctx" ] || exit 0

if command -v jq >/dev/null 2>&1; then
  jq -n --arg c "$ctx" '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $c}}' 2>/dev/null \
    || printf '%s\n' "$ctx"
else
  printf '%s\n' "$ctx"
fi
exit 0
