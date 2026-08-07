#!/usr/bin/env bash
# worker-package.test.sh — builder checks: the envelope must be built honestly
# or not at all. Uses a `gh` shim so no network or auth is involved.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

# gh shim: `gh issue view <n> --repo … --json …` → canned JSON with an
# engsys:issue-meta block carrying touches, spec_refs, and (issue 9) no_external.
mkdir -p "$T/bin"
cat > "$T/bin/gh" <<'EOF'
#!/usr/bin/env bash
n="$3"
if [ "$n" = "9" ]; then ne=true; else ne=false; fi
python3 - "$n" "$ne" <<'PY'
import json, sys
n, ne = sys.argv[1], sys.argv[2] == 'true'
body = ("Do the thing.\n\n<!-- engsys:issue-meta\n"
        "depends_on: []\n"
        'touches: ["src/lib/**"]\n'
        "risk: low\n"
        "needs_judgment: false\n"
        'spec_refs: ["docs/specs/foo.md#Receipt drawer"]\n'
        f"no_external: {'true' if ne else 'false'}\n"
        "-->\n")
print(json.dumps({"title": f"Test issue {n}", "body": body, "state": "OPEN"}))
PY
EOF
chmod +x "$T/bin/gh"
export PATH="$T/bin:$PATH"

# Project skeleton: repo + installed layout + filled overlay + a spec to slice.
git -C "$T" init -q proj
cd "$T/proj"
git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git remote add origin git@github.com:acme/widget.git
mkdir -p .claude/scripts/workers .claude/workflows/briefs docs/specs
cp "$HERE/worker-package.mjs" .claude/scripts/
cp "$HERE/../workflows/briefs/"*.md .claude/workflows/briefs/
cat > .claude/scripts/providers.json <<'EOF'
{ "workers": { "test": { "enabled": true, "family": "test",
  "roles": ["implement", "review"], "models": { "implement": "test-1", "review": "test-1" } } },
  "timeouts": { "implement": 60, "review": 60 } }
EOF
cat > docs/specs/foo.md <<'EOF'
# Foo spec

## Intro

Not this.

## Receipt drawer

The drawer must show the receipt.

## After

Not this either.
EOF
cat > .claude/workflows/briefs/project-brief-overlay.md <<'EOF'
# Project brief overlay

## Hard invariants
No real people.

## Verify commands
```sh
npm run check
```
EOF

PASS=0; FAIL=0; N=0
say() { N=$((N+1)); if [ "$1" = ok ]; then PASS=$((PASS+1)); echo "  ok  $2"; else FAIL=$((FAIL+1)); echo "  FAIL $2"; fi }

echo "worker-package builder:"

# 1. Happy path: contract + churn + spec slice + overlay + verify all land.
OUT="$(node .claude/scripts/worker-package.mjs --role implement --provider test --issues 244 --run-id t1 2>&1)" || { echo "$OUT"; exit 1; }
P=tmp/worker-package/t1
grep -q 'PACKAGE_HASH=' <<<"$OUT" && say ok "prints the package hash" || say no "prints the package hash"
grep -q 'Declared churn (binding)' "$P/contract/issue-244.md" && say ok "touches → binding churn list" || say no "touches → binding churn list"
S="$(ls "$P"/contract/spec-* 2>/dev/null | head -1)"
[ -n "$S" ] && grep -q 'drawer must show the receipt' "$S" && ! grep -q 'Not this' "$S" \
  && say ok "spec_refs → extracted slice (only the cited section)" || say no "spec_refs → extracted slice"
grep -q 'No real people' "$P/brief.md" && say ok "overlay folded into brief.md" || say no "overlay folded into brief.md"
grep -q 'npm run check' "$P/verify.md" && say ok "verify commands extracted from overlay" || say no "verify commands extracted"
node -e "JSON.parse(require('fs').readFileSync('$P/manifest.json','utf8'))" && say ok "manifest parses" || say no "manifest parses"

# 2. Packages are immutable: same run-id refuses.
set +e; node .claude/scripts/worker-package.mjs --role implement --provider test --issues 244 --run-id t1 >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 2 ] && say ok "same run-id refuses (immutable envelope)" || say no "same run-id refuses (got $rc)"

# 3. no_external issue on an outside-boundary family refuses.
set +e; node .claude/scripts/worker-package.mjs --role implement --provider test --issues 9 --run-id t3 >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 2 ] && say ok "no_external refuses outside-boundary provider" || say no "no_external refuses (got $rc)"

# 4. Review with a bare overlay refuses; --allow-bare-overlay overrides.
sed -i.bak 's/No real people./TODO(naturalize) fill me/' .claude/workflows/briefs/project-brief-overlay.md
set +e; node .claude/scripts/worker-package.mjs --role review --provider test --issues 244 --run-id t4 >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 2 ] && say ok "review refuses an unfilled overlay" || say no "review refuses unfilled overlay (got $rc)"
set +e; node .claude/scripts/worker-package.mjs --role review --provider test --issues 244 --run-id t5 --allow-bare-overlay >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 0 ] && say ok "--allow-bare-overlay overrides deliberately" || say no "--allow-bare-overlay overrides (got $rc)"
mv .claude/workflows/briefs/project-brief-overlay.md.bak .claude/workflows/briefs/project-brief-overlay.md

# 5. Missing verify block refuses an implement package.
sed -i.bak '/## Verify commands/,$d' .claude/workflows/briefs/project-brief-overlay.md
set +e; node .claude/scripts/worker-package.mjs --role implement --provider test --issues 244 --run-id t6 >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 2 ] && say ok "implement refuses a missing verify block" || say no "missing verify block (got $rc)"

echo
echo "$PASS/$N passed."
[ "$FAIL" -eq 0 ] || exit 1
