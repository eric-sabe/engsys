#!/usr/bin/env bash
# az-sp-login.sh — keep a fleet's isolated az profile logged in as its Azure service principal
# (certificate credential), without ever touching an operator's interactive ~/.azure profile.
#
# The fleet's identity lives in its own AZURE_CONFIG_DIR; SDK-based tools don't even need the
# CLI login — they pick up AZURE_CLIENT_ID / AZURE_TENANT_ID / AZURE_CLIENT_CERTIFICATE_PATH via
# EnvironmentCredential. This script covers the `az` CLI path and acts as a scheduled self-heal
# (profile wiped, certificate rotated, first boot).
#
# Idempotent: exits 0 fast when the profile already mints tokens for the right identity.
# Runs under a scheduler (for example a launchd job every 6 hours) and as a preflight.
#
# Usage: az-sp-login.sh [path-to-env-file]
#   The env file is the argument, or AZURE_SP_ENV; there is no default location. It is
#   machine-local, chmod 600, never committed. Keys and rotation: README.md (next to this script).
set -euo pipefail

ENV_FILE="${1:-${AZURE_SP_ENV:-}}"
if [ -z "$ENV_FILE" ]; then
  echo "az-sp-login: no env file — pass it as the first argument or set AZURE_SP_ENV" >&2
  exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "az-sp-login: env file not found: $ENV_FILE" >&2
  echo "  (this machine has no service-principal identity configured — see README.md next to this script)" >&2
  exit 1
fi

set -a
# shellcheck source=/dev/null
. "$ENV_FILE"
set +a

: "${AZURE_CONFIG_DIR:?env file must set AZURE_CONFIG_DIR}"
: "${AZURE_CLIENT_ID:?env file must set AZURE_CLIENT_ID}"
: "${AZURE_TENANT_ID:?env file must set AZURE_TENANT_ID}"
: "${AZURE_CLIENT_CERTIFICATE_PATH:?env file must set AZURE_CLIENT_CERTIFICATE_PATH}"
: "${AZURE_SUBSCRIPTION_ID:?env file must set AZURE_SUBSCRIPTION_ID}"
export AZURE_CONFIG_DIR

if [ ! -f "$AZURE_CLIENT_CERTIFICATE_PATH" ]; then
  echo "az-sp-login: certificate not found: $AZURE_CLIENT_CERTIFICATE_PATH" >&2
  exit 1
fi

# Fast path: profile already valid AND holds the RIGHT identity. A minted
# token alone isn't enough — if this profile were ever logged in as some other
# account (operator experiment, stale state), exiting here would silently run
# the fleet under the wrong principal. Verify user (the SP appId), tenant,
# and subscription all match before trusting it; any mismatch falls through
# to a clean re-login.
if ACCT=$(az account show --query "[user.name,tenantId,id]" -o tsv 2>/dev/null); then
  CUR_USER=$(echo "$ACCT" | sed -n 1p)
  CUR_TENANT=$(echo "$ACCT" | sed -n 2p)
  CUR_SUB=$(echo "$ACCT" | sed -n 3p)
  if [ "$CUR_USER" = "$AZURE_CLIENT_ID" ] \
    && [ "$CUR_TENANT" = "$AZURE_TENANT_ID" ] \
    && [ "$CUR_SUB" = "$AZURE_SUBSCRIPTION_ID" ] \
    && az account get-access-token --query expiresOn -o tsv >/dev/null 2>&1; then
    echo "az-sp-login: service-principal profile OK ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
    exit 0
  fi
  echo "az-sp-login: profile present but wrong identity/tenant/sub or dead token — re-logging in"
fi

echo "az-sp-login: (re)logging in the service-principal profile"
az login --service-principal \
  --username "$AZURE_CLIENT_ID" \
  --certificate "$AZURE_CLIENT_CERTIFICATE_PATH" \
  --tenant "$AZURE_TENANT_ID" -o none
az account set --subscription "$AZURE_SUBSCRIPTION_ID"
az account get-access-token --query expiresOn -o tsv >/dev/null
echo "az-sp-login: login OK ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
