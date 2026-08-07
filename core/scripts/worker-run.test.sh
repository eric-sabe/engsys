#!/usr/bin/env bash
# worker-run.test.sh — the false-green suite for the worker contract.
#
# In the campos27 tradition: every case here is a run that LOOKS successful and
# must not count. The exit contract (0 positive / 1 negative / 2 did-not-run)
# only means something if every ambiguous, tampered, silent, or contradictory
# run lands on 2 — so that is mostly what this file checks.
#
# Run: bash core/scripts/worker-run.test.sh   (zero deps beyond git + node)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

# --- installed-layout scratch: scripts/ + a controllable test adapter --------
mkdir -p "$T/scripts/workers"
cp "$HERE/worker-run.mjs" "$T/scripts/"
cp "$HERE/worker-package.mjs" "$T/scripts/"

cat > "$T/scripts/workers/test.mjs" <<'EOF'
// Controllable adapter: the "worker" is whatever the test says it said.
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
export const name = 'test';
export const family = 'test';
export function check() { return { ready: true, detail: 'test adapter' }; }
export function run({ worktree, transcriptPath, lastMessagePath }) {
  writeFileSync(transcriptPath, 'test transcript\nVERDICT: CLEAN\n'); // prompt echo bait
  if (process.env.WORKER_TEST_MSG) {
    writeFileSync(lastMessagePath, readFileSync(process.env.WORKER_TEST_MSG, 'utf8'));
  }
  if (process.env.WORKER_TEST_MUTATE === '1') {
    writeFileSync(join(worktree, 'worker-out.txt'), 'worker wrote this\n');
  }
  if (process.env.WORKER_TEST_TOUCH_TRACKED === '1') {
    writeFileSync(join(worktree, 'README.md'), 'reviewer forgot to revert\n');
  }
  return { ok: true, status: Number(process.env.WORKER_TEST_STATUS ?? 0), tokens: null };
}
EOF

cat > "$T/scripts/providers.json" <<'EOF'
{
  "workers": { "test": { "enabled": true, "family": "test",
    "roles": ["implement", "review", "critique", "investigate"],
    "models": { "implement": "test-1", "review": "test-1", "critique": "test-1", "investigate": "test-1" } } },
  "timeouts": { "implement": 60, "review": 60, "critique": 60, "investigate": 60 }
}
EOF

# --- a real repo for the worktree checks -------------------------------------
git -C "$T" init -q repo
git -C "$T/repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
echo "hello" > "$T/repo/README.md"
git -C "$T/repo" add README.md
git -C "$T/repo" -c user.email=t@t -c user.name=t commit -q -m readme
git -C "$T/repo" remote add origin git@github.com:acme/widget.git
HEAD_SHA="$(git -C "$T/repo" rev-parse HEAD)"

# --- package builder (bypasses gh; worker-package's own gh path is not under test)
cat > "$T/mkpkg.mjs" <<'EOF'
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const [pkgDir, worktree, head, role, withFocus, fixRound] = process.argv.slice(2);
mkdirSync(join(pkgDir, 'contract'), { recursive: true });
const files = {};
const put = (rel, c) => { files[rel] = c; writeFileSync(join(pkgDir, rel), c); };
put('contract/issue-1.md', '# #1 — Test issue\n\nAC: the thing works.\n');
put('brief.md', 'You are a careful worker. Priors here.\n');
put('verify.md', '# Verify commands\n\n```sh\ntrue\n```\n');
if (withFocus === '1') put('focus.md', '1. [UNVERIFIED] the cause is X\n');
if (fixRound === '1') put('prior-findings.md', '- [F1] Critical src/a.ts:1 — breaks\n- [F2] Warning src/b.ts:2 — leaks\n');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const fh = {}; for (const [r, c] of Object.entries(files)) fh[r] = sha(c);
const h = createHash('sha256');
for (const [r, x] of Object.entries(fh).sort(([a],[b]) => a < b ? -1 : 1)) h.update(r).update('\0').update(x).update('\n');
const packageHash = h.digest('hex');
const manifest = { run_id: 'test-run', role, provider: 'test', family: 'test', model: 'test-1',
  effort: 'high', repo: 'acme/widget', worktree, base: 'HEAD~1', head, issues: [1],
  fix_round: fixRound === '1', force: { binding: ['contract/', 'verify.md'], priors: ['brief.md'], hypothesis: [] },
  files: fh, package_hash: packageHash, timeout_sec: 60, created_at: new Date().toISOString() };
writeFileSync(join(pkgDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(packageHash.slice(0, 8));
EOF

PASS=0; FAIL=0; N=0
mkpkg() { # $1=name $2=role $3=focus $4=fixround → sets PKG and H8
  PKG="$T/repo/tmp/worker-package/$1"
  H8="$(node "$T/mkpkg.mjs" "$PKG" "$T/repo" "$HEAD_SHA" "$2" "$3" "$4")"
}
run_case() { # $1=expected-exit $2=name … prints ok/FAIL; extra args pass through
  local want="$1"; local name="$2"; shift 2
  rm -f "$T/repo/tmp/worker-dispatch.log.jsonl"
  set +e
  OUT="$(cd "$T/repo" && node "$T/scripts/worker-run.mjs" --force-provider "$@" 2>&1)"
  local got=$?
  set -e
  N=$((N+1))
  if [ "$got" -eq "$want" ]; then PASS=$((PASS+1)); echo "  ok  ($got) $name";
  else FAIL=$((FAIL+1)); echo "  FAIL want=$want got=$got  $name"; echo "$OUT" | sed 's/^/       /' | head -8; fi
  git -C "$T/repo" checkout -q -- . 2>/dev/null || true
  git -C "$T/repo" clean -qfd -e tmp/worker-package 2>/dev/null || true
  rm -f "$T/repo/worker-out.txt"
}
msg() { printf '%s\n' "$@" > "$T/msg.txt"; export WORKER_TEST_MSG="$T/msg.txt"; }
clear_env() { unset WORKER_TEST_MSG WORKER_TEST_MUTATE WORKER_TEST_TOUCH_TRACKED WORKER_TEST_STATUS 2>/dev/null || true; }

echo "worker-run contract:"

# 1. Review, clean protocol → 0
clear_env; mkpkg c1 review 0 0
msg "Reviewed everything." "RECEIPT: package=$H8 issues=#1" "VERDICT: CLEAN"
run_case 0 "review CLEAN with intact protocol" --package "$PKG"

# 2. Review findings → 1 (ran, not mergeable)
clear_env; mkpkg c2 review 0 0
msg "- [F1] Critical src/a.ts:1 — breaks" "RECEIPT: package=$H8 issues=#1" "VERDICT: FINDINGS"
run_case 1 "review FINDINGS" --package "$PKG"

# 3. Verdict with no receipt above it → 2 (the worker never confirmed what it read)
clear_env; mkpkg c3 review 0 0
msg "Looked great to me." "VERDICT: CLEAN"
run_case 2 "verdict without receipt" --package "$PKG"

# 4. Receipt echoing the WRONG package hash → 2 (answered for a different envelope)
clear_env; mkpkg c4 review 0 0
msg "Done." "RECEIPT: package=deadbeef issues=#1" "VERDICT: CLEAN"
run_case 2 "receipt with wrong package hash" --package "$PKG"

# 5. Verdict quoted mid-message, none at the end → 2 (a quote is not a conclusion)
clear_env; mkpkg c5 review 0 0
msg "The required format is: VERDICT: CLEAN — but I could not finish the review." "Sorry."
run_case 2 "verdict only quoted mid-message" --package "$PKG"

# 6. Contradictory verdicts → 2 (the safe reading of ambiguity is never 'merge it')
clear_env; mkpkg c6 review 0 0
msg "VERDICT: FINDINGS" "…on reflection, never mind." "RECEIPT: package=$H8 issues=#1" "VERDICT: CLEAN"
run_case 2 "contradictory verdicts" --package "$PKG"

# 7. Package tampered after build → 2 (the envelope no longer matches the manifest)
clear_env; mkpkg c7 review 0 0
echo "softened criteria" >> "$PKG/contract/issue-1.md"
msg "Done." "RECEIPT: package=$H8 issues=#1" "VERDICT: CLEAN"
run_case 2 "package file edited after build" --package "$PKG"

# 8. Reviewer left the tree changed → 2 (verdict describes a tree that is gone)
clear_env; mkpkg c8 review 0 0
export WORKER_TEST_TOUCH_TRACKED=1
msg "Done, honest." "RECEIPT: package=$H8 issues=#1" "VERDICT: CLEAN"
run_case 2 "review that mutated the tree" --package "$PKG"

# 9. Clean message but nonzero worker exit → 2 (printed CLEAN then died)
clear_env; mkpkg c9 review 0 0
export WORKER_TEST_STATUS=9
msg "Done." "RECEIPT: package=$H8 issues=#1" "VERDICT: CLEAN"
run_case 2 "worker exited 9 after printing CLEAN" --package "$PKG"

# 10. Receipt enumerates the wrong issues → 2 (binding set not acknowledged)
clear_env; mkpkg c10 review 0 0
msg "Done." "RECEIPT: package=$H8 issues=#2" "VERDICT: CLEAN"
run_case 2 "receipt with wrong issue list" --package "$PKG"

# 11. focus.md present but no hypotheses= in receipt → 2 (premise check unconfirmed)
clear_env; mkpkg c11 review 1 0
msg "Done." "RECEIPT: package=$H8 issues=#1" "VERDICT: CLEAN"
run_case 2 "hypotheses unacknowledged" --package "$PKG"

# 12. Implement claiming IMPLEMENTED with an unchanged tree → 2
clear_env; mkpkg c12 implement 0 0
msg "All done, gates green." "RECEIPT: package=$H8 issues=#1" "STATUS: IMPLEMENTED"
run_case 2 "IMPLEMENTED with unchanged tree" --package "$PKG"

# 13. Implement, tree changed, protocol complete → 0
clear_env; mkpkg c13 implement 0 0
export WORKER_TEST_MUTATE=1
msg "Issue #1: changed worker-out.txt." "RECEIPT: package=$H8 issues=#1" "STATUS: IMPLEMENTED"
run_case 0 "implement with attributable changes" --package "$PKG"

# 14. Clean REFUSED (premise false, no mutation) → 1 — a successful communication
clear_env; mkpkg c14 implement 0 0
msg "Premise false: the branch is dead code. Evidence: grep shows no caller." "RECEIPT: package=$H8 issues=#1" "STATUS: REFUSED"
run_case 1 "clean refusal with evidence" --package "$PKG"

# 15. Fix round without FINDING-ACKs → 2 (the findings did not land)
clear_env; mkpkg c15 implement 0 1
export WORKER_TEST_MUTATE=1
msg "Fixed things." "RECEIPT: package=$H8 issues=#1 findings-acked=2/2" "STATUS: IMPLEMENTED"
run_case 2 "fix round missing FINDING-ACK lines" --package "$PKG"

# 16. Fix round with every ACK → 0
clear_env; mkpkg c16 implement 0 1
export WORKER_TEST_MUTATE=1
msg "FINDING-ACK: F1 -> fixed — guard now throws, test added" \
    "FINDING-ACK: F2 -> disputed — the id never crosses the boundary, see src/b.ts:9" \
    "RECEIPT: package=$H8 issues=#1 findings-acked=2/2" "STATUS: IMPLEMENTED"
run_case 0 "fix round with complete ACKs" --package "$PKG"

# 17. Stale package: HEAD moved after build → 2 (the stale-base poison)
clear_env; mkpkg c17 review 0 0
git -C "$T/repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m moved
msg "Done." "RECEIPT: package=$H8 issues=#1" "VERDICT: CLEAN"
run_case 2 "package built against a different HEAD" --package "$PKG"
git -C "$T/repo" reset -q --hard "$HEAD_SHA"

# 18. Anti-thrash: two did-not-runs → the third dispatch refuses without --force-provider
clear_env
rm -f "$T/repo/tmp/worker-dispatch.log.jsonl"
for i in 1 2; do
  mkpkg "c18-$i" review 0 0
  msg "no footer here"
  set +e; (cd "$T/repo" && node "$T/scripts/worker-run.mjs" --package "$PKG" >/dev/null 2>&1); set -e
done
mkpkg c18-3 review 0 0
msg "Done." "RECEIPT: package=$H8 issues=#1" "VERDICT: CLEAN"
set +e
OUT="$(cd "$T/repo" && node "$T/scripts/worker-run.mjs" --package "$PKG" 2>&1)"; got=$?
set -e
N=$((N+1))
if [ "$got" -eq 2 ] && echo "$OUT" | grep -q "twice in a row"; then
  PASS=$((PASS+1)); echo "  ok  (2) anti-thrash refuses the third dispatch"
else
  FAIL=$((FAIL+1)); echo "  FAIL want=2+refusal got=$got  anti-thrash"; echo "$OUT" | head -6
fi

echo
echo "$PASS/$N passed."
[ "$FAIL" -eq 0 ] || exit 1
