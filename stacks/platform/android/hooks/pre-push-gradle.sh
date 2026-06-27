#!/usr/bin/env bash
# pre-push hook — runs a fast Gradle gate when Android files are being pushed.
# Prevents broken Android builds from reaching the default branch.
#
# Gate: assembleDebug + unit tests + lint (no emulator required).
#
# Install once per clone:
#   git config core.hooksPath .githooks
#
# Naturalize the project facts below to match this repo:
#   ANDROID_PATH_PREFIX  — repo-relative path that, when touched, should trigger the gate
#   ANDROID_DIR          — directory containing ./gradlew (Gradle project root)
#   GRADLE_MODULE        — the app module (e.g. ":app"); leave empty for a single-module root

set -euo pipefail

# --- Project facts (naturalize) ---------------------------------------------
ANDROID_PATH_PREFIX="${ANDROID_PATH_PREFIX:-packages/android/}"
ANDROID_DIR="${ANDROID_DIR:-packages/android}"
GRADLE_MODULE="${GRADLE_MODULE:-:app}"
# ----------------------------------------------------------------------------

REMOTE="${1:-}"
REMOTE_URL="${2:-}"

ANDROID_CHANGED=0

while read -r local_ref local_sha remote_ref remote_sha; do
    # New branch — compare against empty tree
    if [[ "$remote_sha" == "0000000000000000000000000000000000000000" ]]; then
        base=$(git hash-object -t tree /dev/null)
    else
        base="$remote_sha"
    fi

    if git diff --name-only "$base" "$local_sha" 2>/dev/null | grep -q "^${ANDROID_PATH_PREFIX}"; then
        ANDROID_CHANGED=1
        break
    fi
done

if [[ "$ANDROID_CHANGED" -eq 0 ]]; then
    exit 0
fi

# Resolve task names. With a module prefix, tasks are e.g. ":app:assembleDebug".
ASSEMBLE_TASK="${GRADLE_MODULE:+$GRADLE_MODULE:}assembleDebug"
TEST_TASK="${GRADLE_MODULE:+$GRADLE_MODULE:}testDebugUnitTest"
LINT_TASK="${GRADLE_MODULE:+$GRADLE_MODULE:}lintDebug"

GRADLEW="./gradlew"
if [[ ! -x "${ANDROID_DIR}/${GRADLEW}" && ! -f "${ANDROID_DIR}/gradlew" ]]; then
    echo "⚠️  No gradlew found in ${ANDROID_DIR} — skipping Android gate."
    echo "    Naturalize ANDROID_DIR to the Gradle project root to enable it."
    exit 0
fi

echo "🤖 Android files changed — running the Gradle gate (assemble + tests + lint)..."
echo ""

if ! (cd "$ANDROID_DIR" && ./gradlew "$ASSEMBLE_TASK" "$TEST_TASK" "$LINT_TASK" --console=plain) 2>&1; then
    echo ""
    echo "❌ Gradle gate failed. Fix the build/tests/lint before pushing."
    echo "   Reproduce: (cd ${ANDROID_DIR} && ./gradlew ${ASSEMBLE_TASK} ${TEST_TASK} ${LINT_TASK})"
    exit 1
fi

echo ""
echo "✅ Android gate passed (assembleDebug + unit tests + lint)."
exit 0
