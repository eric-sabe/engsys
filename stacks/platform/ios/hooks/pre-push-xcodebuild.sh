#!/usr/bin/env bash
# pre-push hook — runs SwiftLint + xcodebuild when iOS files are being pushed.
# Prevents broken iOS builds from reaching CI / the default branch.
#
# Install once per clone:
#   git config core.hooksPath .githooks
#
# Naturalize the three project facts below to match this repo:
#   IOS_PATH_PREFIX  — repo-relative path that, when touched, should trigger a build
#   PROJECT          — path to the .xcodeproj (or use -workspace + WORKSPACE)
#   SCHEME           — the build scheme
#   LINT_DIR         — directory to run swiftlint from (so .swiftlint.yml resolves)

set -euo pipefail

# --- Project facts (naturalize) ---------------------------------------------
IOS_PATH_PREFIX="packages/ios/"
PROJECT="packages/ios/App/App.xcodeproj"
SCHEME="App"
LINT_DIR="packages/ios/App"
# ----------------------------------------------------------------------------

REMOTE="${1:-}"
REMOTE_URL="${2:-}"

IOS_CHANGED=0

while read -r local_ref local_sha remote_ref remote_sha; do
    # New branch — compare against empty tree
    if [[ "$remote_sha" == "0000000000000000000000000000000000000000" ]]; then
        base=$(git hash-object -t tree /dev/null)
    else
        base="$remote_sha"
    fi

    if git diff --name-only "$base" "$local_sha" 2>/dev/null | grep -q "^${IOS_PATH_PREFIX}"; then
        IOS_CHANGED=1
        break
    fi
done

if [[ "$IOS_CHANGED" -eq 0 ]]; then
    exit 0
fi

echo "📱 iOS files changed — running SwiftLint before push..."
echo ""

if command -v swiftlint &>/dev/null; then
    # Run from the iOS project dir so .swiftlint.yml is resolved correctly
    # and its included/excluded paths are respected.
    if ! (cd "$LINT_DIR" && swiftlint lint --quiet --reporter emoji) 2>&1; then
        echo ""
        echo "❌ SwiftLint failed. Fix the violations before pushing."
        exit 1
    fi
    echo "✅ SwiftLint passed."
else
    echo "⚠️  swiftlint not found — skipping lint (brew install swiftlint to enable)."
fi

echo ""
echo "🔨 Running xcodebuild build-for-testing..."
echo ""

if ! xcodebuild build-for-testing \
    -project "$PROJECT" \
    -scheme "$SCHEME" \
    -destination "generic/platform=iOS Simulator" \
    -configuration Debug \
    CODE_SIGNING_ALLOWED=NO \
    ASSETCATALOG_COMPILER_SKIP_APP_STORE_DEPLOYMENT=YES \
    -quiet 2>&1; then
    echo ""
    echo "❌ xcodebuild build-for-testing failed. Fix the build before pushing."
    echo "   Run with more detail: xcodebuild build-for-testing -project $PROJECT -scheme $SCHEME -destination 'generic/platform=iOS Simulator' -configuration Debug CODE_SIGNING_ALLOWED=NO"
    exit 1
fi

echo ""
echo "✅ iOS build (including tests) passed."
exit 0
