#!/usr/bin/env bash
# Stack-pack post-edit reminder (platform/web). Called by .claude/hooks/post-edit-reminders.sh
# with the edited file path as $1, only when no project hook_pattern matched it.
case "${1:-}" in
  */node_modules/*) ;;
  */middleware.ts|*/middleware.js)
    echo "↳ middleware file edited — on Next.js 16+ request-edge code belongs in proxy.ts (middleware.ts + proxy.ts together is a build error). See the web-platform-conventions skill. Ignore if this isn't a Next.js app."
    ;;
esac
exit 0
