#!/usr/bin/env bash
# Stack-pack post-edit reminder (iac/bicep). Called by .claude/hooks/post-edit-reminders.sh
# with the edited file path as $1, only when no project hook_pattern matched it.
case "${1:-}" in
  *.bicep|*.bicepparam)
    echo "↳ Bicep changed — before push: \`az bicep build\` (syntax only), then \`az deployment group validate\` + \`what-if\` against the target resource group. The azure-deployment-preflight skill runs the full gate; fix failures locally, batch fixes, push once."
    ;;
esac
exit 0
