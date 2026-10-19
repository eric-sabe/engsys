#!/usr/bin/env bash
# fake-github.sh: answer the read-only GitHub REST calls `fleet verify` makes about the pin repo, from a
# local (bare) git repo standing in for GitHub. Sourced by the test gh stubs, never run on its own.
#
#   fake_github_api <git dir> <path after repos/<owner>/<repo>>   → JSON on stdout, or exit 1 with
#                                                                   "gh: Not Found (HTTP 404)" on stderr
#
# Covers: '' (the repo: default_branch main), git/ref/heads/<b>, git/ref/tags/<t>, git/blobs/<sha>, compare/<base>...<head>, git/commits/<sha>,
# git/trees/<sha>[?recursive=1] and contents/<path>?ref=<sha>.
fake_github_404() { echo '{"message":"Not Found"}'; echo "gh: Not Found (HTTP 404)" >&2; return 1; }
fake_github_commit() { git -C "$1" rev-parse -q --verify "$2^{commit}" 2>/dev/null; }
fake_github_api() {
  local G="$1" p="$2" q="" a b ca cb mb t
  case "$p" in *\?*) q="${p#*\?}"; p="${p%%\?*}" ;; esac
  case "$p" in
    '') echo '{"default_branch":"main"}' ;;
    git/ref/tags/*)
      ca="$(fake_github_commit "$G" "refs/tags/${p#git/ref/tags/}")" || { fake_github_404; return 1; }
      printf '{"ref":"refs/tags/%s","object":{"type":"commit","sha":"%s"}}\n' "${p#git/ref/tags/}" "$ca" ;;
    git/blobs/*)
      t="${p#git/blobs/}"
      git -C "$G" cat-file -e "$t^{blob}" 2>/dev/null || { fake_github_404; return 1; }
      printf '{"sha":"%s","encoding":"base64","content":"%s"}\n' "$t" "$(git -C "$G" cat-file blob "$t" | base64 | tr -d '\n')" ;;
    git/ref/heads/*)
      ca="$(fake_github_commit "$G" "refs/heads/${p#git/ref/heads/}")" || { fake_github_404; return 1; }
      printf '{"ref":"refs/heads/%s","object":{"type":"commit","sha":"%s"}}\n' "${p#git/ref/heads/}" "$ca" ;;
    compare/*...*)
      a="${p#compare/}"; b="${a#*...}"; a="${a%%...*}"
      ca="$(fake_github_commit "$G" "$a")" && cb="$(fake_github_commit "$G" "$b")" || { fake_github_404; return 1; }
      if [ "$ca" = "$cb" ]; then t=identical
      else
        mb="$(git -C "$G" merge-base "$ca" "$cb" 2>/dev/null || true)"
        if [ "$mb" = "$ca" ]; then t=ahead; elif [ "$mb" = "$cb" ]; then t=behind; else t=diverged; fi
      fi
      printf '{"status":"%s"}\n' "$t" ;;
    git/commits/*)
      ca="$(fake_github_commit "$G" "${p#git/commits/}")" || { fake_github_404; return 1; }
      printf '{"sha":"%s","tree":{"sha":"%s"}}\n' "$ca" "$(git -C "$G" rev-parse "$ca^{tree}")" ;;
    git/trees/*)
      t="${p#git/trees/}"
      git -C "$G" cat-file -e "$t^{tree}" 2>/dev/null || { fake_github_404; return 1; }
      local r=""; [ "$q" = recursive=1 ] && r="-r"
      # shellcheck disable=SC2086 # r is one optional flag
      git -C "$G" ls-tree $r "$t" | awk -F'\t' '{ split($1, a, " "); printf "%s\t%s\t%s\t%s\n", a[1], a[2], a[3], $2 }' \
        | jq -R -s --arg s "$t" '{sha: $s, truncated: false, tree: [split("\n")[] | select(length > 0) | split("\t") | {mode: .[0], type: .[1], sha: .[2], path: .[3]}]}' ;;
    contents/*)
      a="${q#ref=}"
      ca="$(fake_github_commit "$G" "$a")" || { fake_github_404; return 1; }
      b="$(git -C "$G" ls-tree "$ca" -- "${p#contents/}" | awk -F'\t' '$1 ~ / blob / { split($1, x, " "); print x[3] }')"
      [ -n "$b" ] || { fake_github_404; return 1; }
      printf '{"type":"file","path":"%s","sha":"%s"}\n' "${p#contents/}" "$b" ;;
    *) fake_github_404; return 1 ;;
  esac
}
