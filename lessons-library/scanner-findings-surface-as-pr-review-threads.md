# A red static-analysis check can be a real finding hiding in a review thread

**Trigger:** A required code-scanning check (CodeQL or similar) shows FAILURE on a PR, and the first read is "stale or zombie check, not a real finding".

**Failure mode:** The alerts API for the branch returns an empty list, which gets taken as "zero alerts, benign". But scanner findings on a PR are also posted as review threads authored by the scanner's bot account, and the alerts API can lag, be scoped differently, or return `[]` while a blocking finding sits unresolved on the diff (for example, a polynomial-backtracking regex on user-provided input). A red check can be zombie, real, or both: a new commit clears the zombie half, but a real finding in the PR's own code persists across new SHAs.

**Correct behavior:**
- On any scanner-check failure, check both: unresolved review threads (the authoritative PR-level signal; a thread authored by the scanner bot is a real finding) and the alerts API.
  ```bash
  gh api graphql -f query='query{repository(owner:"O",name:"R"){pullRequest(number:N){
    reviewThreads(first:50){nodes{isResolved path line comments(first:1){nodes{author{login} bodyText}}}}}}}' \
    --jq '.data.repository.pullRequest.reviewThreads.nodes[]|select(.isResolved==false)'
  ```
- Never conclude "benign zombie" without reading the threads.
- A security finding in the PR's own code is a substantive thread: do not resolve it to unblock. Bounce to the author for a code fix; a false-positive dismissal is an explicit owner decision, not something a merge agent does.
- Zombie checks often come from concurrency cancellation when two events fire back to back (marking ready and labeling). Apply the label before marking ready, or tolerate the double run and know it can wedge the check until a new commit.

**Check:** Did you read unresolved threads, not only the alerts endpoint, before calling the check a zombie?

**Seen in:** recurring in merge-queue workflows that gate on code scanning.
