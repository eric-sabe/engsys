# Review verdicts and CI greens belong to a commit, not to "the PR"

**Trigger:** A gate-heavy or security-sensitive PR has a reviewer sign-off or a green CI, and someone pushes another commit, rebases, or rewrites a shared file from memory.

**Failure mode:**
- A verdict that lives only in chat between agents is not an audit trail; nobody can check it against what actually merges.
- A commit appended after sign-off bypasses the review gate entirely, and can merge on a *carried-over* aggregate check computed from the previous head while the real jobs on the new head are still pending. It looks green and is unvalidated.
- Rewriting a shared file (a branch, a notes file, a checklist) from an in-context snapshot silently reverts whatever another actor changed since the snapshot.

**Correct behavior:**
- A durable reviewer verdict names the SHA or commit range it covers, and the merge gate confirms it covers the commit being merged.
- An appended commit invalidates the sign-off: re-review `git diff <reviewed-sha>..HEAD` and require a fresh CI run on the new head, identified by run id, not the previous head's aggregate.
- After a rebase, prove content equivalence with `git range-diff <old-base>..<old-tip> <new-base>..<new-tip>` (every row `=`), or a diff hash, before carrying a verdict forward by evidence rather than assertion.
- Re-read and diff any shared file against its current remote state before overwriting it.

**Check:** Does a durable verdict comment exist that names a range including the current HEAD, and is the CI run you are relying on for that same HEAD and terminal?

**Seen in:** recurring across projects that use reviewer agents and merge queues.
