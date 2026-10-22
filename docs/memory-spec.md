# engsys memory: spec

> Status: **approved for implementation** · 2026-10-14
> Scope: a generic, drop-in memory engine for any repo, or set of repos, that runs engsys. It covers
> lesson matching, push injection into subagents, review-finding harvesting and a GitHub history
> index. Nothing here is specific to one organization. Org wiring (marker names, bot IDs, cadence)
> lives in the instance's config.

## 1. Why

- Lessons in `docs/agent-lessons/` (and `lessons-library/`) only help if an agent goes looking for
  them, and under task pressure it usually doesn't. Subagents never see them unless a persona
  happens to mention the directory.
- Review findings, false-positive acknowledgements, inline review threads and monster bounce
  journals are where recurring mistakes show up. The closeout ceremony mines only one marker, and
  only for multi-PR projects.
- Any pipeline that copies GitHub text into an agent's context is a **stored prompt-injection
  channel**. The design is shaped around that risk.

Non-goals: semantic or embedding search, cross-org sharing, and editing instruction files without a
reviewed PR.

## 2. Trust classes

| Class | What | How it reaches an agent |
|---|---|---|
| **A: instructions** | Files on an allowlist of repo paths: `docs/agent-lessons/**`, the project brief overlay `.claude/workflows/briefs/project-brief-overlay.md`, `docs/architecture/adr/**`, and the bundled `lessons-library/**`. | Pushed through the SubagentStart hook. The instance **should** require human review on these paths; engsys `/naturalize` recommends it. |
| **B: evidence** | Everything ingested from GitHub or from monster journals, **whoever wrote it, bots included**. | Only as **pointers** in the pushed brief: structured fields, no free text. Free text comes on demand through a tool call (`memory-brief --evidence <key>`) and is wrapped by `core/lib/untrusted.mjs`. |

Rules:

1. Being in git does not make text Class A. Only the path allowlist does.
2. SubagentStart `additionalContext` reaches the subagent as a system-role reminder, so **Class B
   free text never goes through the hook**.
3. Agents listed in `exclude_class_b_agents` (by default, any agent whose frontmatter sets
   `security: true`) receive Class A only.
4. "Reviewed" for Class A means: content present at the fully-qualified `refs/remotes/origin/<default>`
   ref (resolved once, pinned to a commit SHA, and used for every subsequent read — never a short
   ref name, which a same-named local branch/tag could otherwise shadow). A local attacker who can
   write directly into `refs/remotes/origin/*` themselves is out of scope — the trust boundary this
   spec defends is the git transport (what actually got reviewed and pushed upstream), not the
   local refs database.

## 3. Storage

### 3.1 Data refs (durable, shared, off-host)

Events are stored as one `events.jsonl` blob in a commit tree on **custom refs in each indexed repo**,
never on a branch:

```text
refs/engsys/memory/events              distilled GitHub events for this repo (single writer)
refs/engsys/memory/<role>/<fleet-id>   a monster's journal tail (one writer per role and fleet)
```

- **Writes** use the lease backend's CAS (`core/lib/lease/github-backend.mjs`): a new commit whose
  parent is the tip just read, then a non-forced `PATCH /git/refs/<ref>`. On a fast-forward rejection,
  re-read, merge by key and retry. Factor the CAS into a shared helper; `ref-store.mjs` allows a
  non-empty tree, while batons keep requiring the empty tree.
- **Each repo's events live in that repo**, so read access follows that repo's access control.
- **Reads:** `git fetch origin 'refs/engsys/memory/*:refs/engsys/memory/*'` (engsys v2.0.1 M4: NOT
  forced — a forced (`+`) refspec lets `git fetch` silently clobber a local ref tip with whatever
  the remote currently has, defeating any after-the-fact trust check on it; a non-fast-forward
  fetch now fails closed instead), then `git show <ref>:events.jsonl`. Clones and worktrees never
  fetch these refs by default, and any event read back this way is untrusted (`author_kind`/
  `author_id` stripped) until `verifyMemoryRefTip` is wired into the reader.
- **Wiring a consumer of these refs requires a security review.** The fetch (`fetchMemoryRefs`) is
  deliberately unwired. Any code that fetches or reads `refs/engsys/memory/*` as trusted input must
  go through `verifyMemoryRefTip` (`ref-store.mjs`) and must not re-implement tip trust. This is
  enforced by `core/lib/memory/ref-consumer-guard.test.mjs`: a file that names the memory refs and
  is not on its short non-consumer list fails the suite, and a listed consumer must call
  `verifyMemoryRefTip(` in code. The only current reader of ref content (`loadClassBEvents`) strips
  every embedded trust label (`author_kind: 'untrusted_ref'`). Adding a consumer means a Nyx
  review, then updating that guard's `CONSUMERS` set and this section in the same PR. A non-forced
  fetch also rejects every fetch after the first compaction (parentless commit); a consumer needs
  the staged-fetch design noted in `ref-store.mjs`, not a forced refspec.
- **Secret scan before every write.** Branch-filtered CI scanners don't cover custom refs. Any match
  rejects the record and logs it.
- **Compaction:** when the blob passes `max_events` (default 20000), the writer keeps the latest
  version of each key, drops tombstones older than 180 days, and writes a parentless commit.
- These refs are not covered by branch rulesets, and anyone with `contents: write` can force-push
  them. Readers therefore treat every event as Class B, and trust a tip only through its fleet
  signature (§9), never its committer (`web-flow` for every API-made commit).

### 3.2 Event record

```json
{"k":"owner/repo:review_thread:123456","kind":"review_thread","repo":"owner/repo","number":412,
 "path":"src/api/tenant.ts","line":88,"symbol":null,"marker":"local-review-findings",
 "outcome":"fixed","author_id":331745698,"author_kind":"bot","editor_id":null,
 "updated_at":"2026-10-14T16:00:00Z","url":"https://github.com/owner/repo/pull/412#discussion_r123456",
 "flags":[],"text":"≤280 chars, links and HTML stripped"}
```

- `kind` ∈ `pr`, `pr_review`, `review_thread`, `marker_finding`, `finding_ack`, `issue`,
  `issue_comment`, `commit`, `journal`.
- `outcome` ∈ `fixed`, `unresolved`, `disputed`, `bounced`, `merged`, `none`.
- A tombstone is `{"k":…,"deleted":true,"updated_at":…}`, written for deleted **or minimized**
  sources.
- Last writer wins by `updated_at`.

### 3.3 Local cache (derived, disposable)

All host-local derived state lives in **`$(git rev-parse --git-common-dir)/engsys-memory/`**. That
directory is shared by every worktree, is never committed, and survives `git worktree remove`:

- `index.sqlite`: the FTS5 index (§4)
- `delta.jsonl`: events fetched since the last ref write (§7)
- `cursors.json`, `quarantine.jsonl`, `injections.jsonl`

## 4. Index: `core/lib/memory/index-db.mjs`

- **Sources:** Class A files, plus the events from every configured repo's ref and the local delta.
- **Watermark:** a manifest of `path → sha1` for every source, plus the engsys version. Directory
  mtimes are **not** used; they miss in-place edits, and git checkout resets them.
- **Rebuild** whenever the manifest differs. Build into `index.sqlite.tmp-<pid>`, then `rename()` it
  into place. Readers open read-only. If a lock or error occurs, **fail open**: return an empty
  result, never throw into a hook. Expected cost is ~100 ms wall for 10k events.
- **Schema:** `docs(key, class, kind, path, symbol, roles, globs, keywords, body)` as FTS5 with
  `porter unicode61`, plus plain tables for frontmatter and the event fields.
- **Runtime:** `node:sqlite` requires Node ≥ 22.5 (FTS5 verified on 22.22). Run with
  `NODE_NO_WARNINGS=1`. If the module is missing, every caller fails open.

## 5. Brief: `core/scripts/memory-brief.mjs`

- **Input:** `agent_type`, the task prompt, the issue number if present, and touched paths (from the
  prompt, or from `git diff --name-only <base>` when a worktree is known).
  **At SubagentStart specifically (§12), the raw payload carries no task-prompt field** — instead,
  `subagent-memory-inject.mjs pre-agent` (registered on `PreToolUse` for `Agent|Task`) stashes a
  short-lived (30 s TTL) pending-dispatch record under `<cacheDir>/pending-dispatch/` containing the
  task prompt, path hints extracted from the prompt, and any target worktree path, which
  `SubagentStart` consumes and forwards to `memory-brief` (#142). When no pending record is present,
  targeting degrades gracefully to `git diff` in `cwd` plus `agent_type`.
- **Output:** at most `brief_bytes` (default 2048).
  1. The overlay, if any.
  2. The top 3–5 Class A lessons, by frontmatter match (`globs` against touched paths, `roles`
     against `agent_type`, `stacks`) blended with BM25 over the prompt.
  3. Up to 3 **Class B pointers**, one line each:
     `[#412 review_thread src/api/tenant.ts:88 local-review-findings fixed 2026-10-12] key=<k>`.
- **Budget split:** lessons and pointers are guaranteed up to half of `brief_bytes`. The overlay
  gets the rest, plus any part of that half they don't use. An overlay that would cut into their
  half is trimmed to whole lines and ends with `[overlay truncated to fit brief_bytes]` (a cut never
  leaves a code fence open). Past that, sections drop from the end: pointers first, then lessons.
  The seeded overlay template is under 1 KB, so a fresh install's brief always has room for lessons.
- **Pointer score** = `anchor × idf(file) × recency × outcome`:
  - **anchor:** 1.0 for the same path and an overlapping line, 0.5 for the same file, 0.2 for the
    same directory.
  - **idf** = `log(N_prs / (1 + prs_touching_file))`.
  - **recency** = `0.5^(age_days / 90)`.
  - **outcome:** fixed 1.0, unresolved 0.5, disputed 0.2.
  - Files matching `high_fanout_globs` are keyed by **symbol** instead (for example a schema model
    or field name taken from the diff).
- **`supersedes`:** a superseded lesson is suppressed. A lesson with `security: true` is suppressed
  only when the superseding lesson is also on a human-reviewed path, and not just in a feature
  branch. Supersede cycles are ignored and logged.
- **Evidence mode:** `memory-brief --evidence <key>` prints that record's text wrapped by
  `createEnvelope({label:'HISTORICAL REPO EVIDENCE'})`, with provenance (author kind, URL, date).
  Agents call it with Bash, so the text arrives as a tool result.

## 6. Injection: `core/.claude-plugin/subagent-memory-inject.mjs` (PreToolUse + SubagentStart)

- At `PreToolUse` (`matcher: "Agent|Task"`, invoked as `subagent-memory-inject.mjs pre-agent`),
  stashes a mode-`0600` pending-dispatch record (30 s TTL) under `<cacheDir>/pending-dispatch/`
  keyed by `(session_id, bareAgentType)` with the task prompt, prompt-extracted file paths, and any
  target worktree path, then returns `{}`.
- At `SubagentStart`, consumes the matching pending-dispatch record (verifying any candidate
  worktree shares `--git-common-dir` with `cwd`), runs `memory-brief` with a 2 s budget, and returns
  `{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":…}}`.
- **Fail-open:** any error, timeout or empty brief returns `{}`. It never blocks a dispatch.
  Keep it separate from any enforcement hook, which must fail closed.
- Logs `{ts, agent_type, lesson_keys, pointer_keys, bytes, ms}` to `injections.jsonl`. These logs are
  the evidence for tuning, and for deciding whether history is worth it.
- Never makes network calls.

## 7. Sync: `core/scripts/memory-sync.mjs`

### 7.1 Surfaces (GraphQL, per repo)

Issues, issue comments, PRs, PR reviews, review threads with their comments, marker comments,
`FINDING-ACK` lines, commits (from local `git log`) and monster journals (from local state dirs).

### 7.2 Eligibility filter (applied at ingest)

- **Drop:** Dependabot and `github-actions` authors, `authorAssociation` of `NONE`, `CONTRIBUTOR` or
  `FIRST_TIME_CONTRIBUTOR` for human users, and bots not on the bot list.
- **Bots** are matched by **user** `databaseId`, not App ID and not login. Resolve each
  `<app-slug>[bot]` to its user ID once (`GET /users/<slug>%5Bbot%5D`) and cache it.
- **Edits:** if `editor` differs from `author`, keep the record only if the editor would also pass
  this filter. Otherwise ingest the pre-edit version from `userContentEdits`, or skip it.
- **Commits:** subject line plus `#refs` and `Closes` lines only. Bodies are kept only for operator
  authors. Skip commits authored or co-authored by Dependabot.
- **Marker comments:** parse the structured finding lines under recognized markers, not the prose
  around them.

### 7.3 Trust (applied when the brief is built)

Store `author_id` and `author_kind` on every record. Trust is evaluated when the brief is built,
against the current config, so removing a bot or operator retroactively drops its records.

### 7.4 Quarantine (boundary spoofing only)

Fold the text with `normalizeUntrusted()` first; the strip uses `\p{Default_Ignorable_Code_Point}`.

- **Quarantine** (record not stored; entry in `quarantine.jsonl` with `{ts, url, author_id, rule,
  span}`) when the text matches `MARKER_RE`, harness tags (`<system-reminder>`, `<system>`,
  `<command-…>`, `<user-prompt-submit-hook>`), or `Human:` / `Assistant:` at the start of a line.
- **Flag only** (`flags` set, score ×0.3) for imperative-override phrasing and shell or exfiltration
  patterns.
- Hidden HTML comments are not a signal; markers are HTML comments.

### 7.5 Cursors, deletions, pagination

- **Cursors:** one per surface, with a 48 h re-fetch overlap so edits are caught.
- **Deletions:** a weekly sweep re-checks ingested keys and writes tombstones for deleted or
  `isMinimized` sources.
- **Pagination:** nested connections are paged. A record that could not be fully paged is flagged
  `truncated`.

### 7.6 Modes

- `--init`: walk back by recency until any cap is reached: 500 commits, 250 merged PRs, 250 issues
  (plus their comments and threads, about 3–4k events in a busy repo).
- `--delta`: since the cursors, into the local `delta.jsonl`. Needs no write access.
- `--publish --role maintain --state-dir DIR [--session NAME]`: merge the delta into
  `refs/engsys/memory/events` via CAS. Run only by the single writer (§9); refused for any other role.
- `--tail --role merge|maintain --fleet ID --state-dir DIR [--session NAME]`: mirror this session's
  journal tail to its own `refs/engsys/memory/<role>/<fleet>` (§9). No GitHub fetch; the delta and
  cursors are left alone.

## 8. Harvest: `core/scripts/harvest-findings.mjs`

- **Scope:** any PR range, including standalone single-issue PRs.
- **Inputs:** the configured markers (default: any leading `<!-- *-(findings|review) -->`),
  `FINDING-ACK` lines, PR reviews, review threads and monster journals.
- **Output:** recurring families by path, symbol and rule, ranked by count and outcome, as a
  **proposed** lessons and overlay diff on a branch with a PR. It **never** edits Class A files on the
  default branch directly. `project-closeout-ceremony.md` calls it instead of its hardcoded marker
  loop.

## 9. Multi-fleet

- **Writers:** exactly one writer per ref (F5).
  - `refs/engsys/memory/events` is written only by the holder of the `maintain` baton
    (`memory-sync --publish --role maintain`, from `mnt-heartbeat.sh`). Merge never writes it:
    `--publish` is refused for any other role, for an explicit `--ref` naming another ref, and while
    config `publish_role` is anything but `maintain`.
  - Each `<role>/<fleet>` tail is written only by that fleet's session for that role
    (`memory-sync --tail`, from both heartbeats, with `FLEET_ID` as the fleet: 1–40 of
    `A-Z a-z 0-9 . _ -`).
  - **The baton fence gates every write.** `ref-store` `writeEvents({ beforeCas })` awaits
    `baton.mjs fence` for the writer's role and session right before each ref update (each CAS
    round, after the commit is built): the baton must still be held with ≥ 60 s left. A refusal moves
    nothing (`fence_refused`, reported as `skipped: "baton_not_held"`); the delta waits for the next
    holder. The window between fence and update is seconds, and a takeover needs the 10-minute TTL to
    lapse; a write that still overlaps a new holder's is a CAS merge by key, never a clobber.
  - Single-writer is a writer-side discipline, not a GitHub control: anyone with `contents: write`
    can force-push these refs, so the boundary is what readers verify (below).
- **Tail content:** only the state dir's `journal-YYYY-MM.jsonl` files (regular files; a symlink is
  never followed), the newest 200 lines, as structured `kind: journal` events: the event token
  (`^[a-z][a-z0-9_.:-]{0,39}$`, else the line is skipped), its timestamp and a PR/issue number. No
  other journal field (actor, notes, free text) is carried.
- **Heartbeats are skip-never-block:** a refused or failed write never fails a heartbeat, and
  `ENGSYS_MEMORY_SYNC=0` turns every sync step off, writes included.
- **Fleet signatures bind a ref to a fleet** (F5, operator decision: option A). GitHub's metadata
  can't: commits made through the Git Data API are committed by `web-flow` (GitHub signs them),
  with the App's bot only as the email-derived author (checked on the live baton refs). So every
  write carries an `events.sig` blob next to `events.jsonl` (`core/lib/memory/signing.mjs`): one
  strictly parsed line holding an Ed25519 signature, made with the writer fleet's key
  (`ENGSYS_MEMORY_SIGNING_KEY_FILE`, fleet-guide § 6.1), over
  `engsys-memory-ref-sig\nv1\nfleet=<fleet>\nref=<full ref>\nparent=<sha|none>\ncontent=<sha256 of events.jsonl>\n`.
  A signature can't be replayed onto another ref, parent or content. `memory-sync` writes nothing
  without a usable key (skipped `no_signing_key`, logged).
- **Readers verify the signature** (`verifyMemoryRefTip`): ref, parent and content digest are
  recomputed from what was read, and the signature is checked against `fleet_memory_pubkeys` (§10). A
  `<role>/<fleet>` tail must be signed by the fleet it names, `events` by any listed fleet. No entry,
  a malformed key, a missing or malformed line, or a bad signature = untrusted. The commit's
  committer/author is not a trust input at all.
- **Still open:** the consumer wiring (staged fetch, so compaction doesn't break non-forced fetches)
  is a separate, Nyx-reviewed item, and `trust.mjs` does not yet accept `author_kind: 'fleet_signed'`.
  Until then no reader trusts these refs (§3.1).
- **Readers:** every fleet fetches every ref.
- **Trust map:** for ref authorship, the operator memory.yml's `fleet_memory_pubkeys` (above; not
  federation.yml, which holds App ids and slugs). For GitHub-sourced events inside a ref, authors stay
  matched by numeric **user** id (§7.2): bot user ids in `trusted_bot_user_ids`, operators in
  `operator_user_ids`.
- **Handoffs:** the tail mirror runs from each monster heartbeat, so a baton handoff strands at most
  one heartbeat interval of journal.

## 10. Config (`.claude/memory.yml`, or `memory.yml` in the fleet config dir)

### Where the config is read (engsys#262)

Four sources, merged by `loadConfig()` (memory-brief.mjs) and, for `repos`, `resolveAllowedRepos()`
(index-db.mjs):

1. **The operator's `memory.yml`** — ONE file, the first of these that is SET
   (`resolveMemoryConfigPath`):
   1. `$ENGSYS_MEMORY_CONFIG`, an absolute path (a relative one is refused, never resolved against the
      cwd). The fleet launcher exports `<fleet config dir>/memory.yml` here for a session on its own
      per-session login dir (`<fleet dir>.sessions/<name>`, engsys#205), which has no `memory.yml`
      of its own by design;
   2. `$CLAUDE_CONFIG_DIR/memory.yml`, the session's Claude Code config dir;
   3. `~/.claude/memory.yml`, Claude Code's default config dir, when `CLAUDE_CONFIG_DIR` is unset
      (an interactive session).
2. **The plugin's own** `$CLAUDE_PLUGIN_ROOT/memory.yml`.
3. **The repo's** `.claude/memory.yml` at the reviewed SHA, only for a repo already allowlisted by
   1, 2 or 4 — never `repos` itself (a repo can't allowlist itself, #145).
4. **`ENGSYS_MEMORY_REPOS`** (comma-separated), extra `repos` entries only.

Scalars: operator file over repo over plugin. List fields are unioned. Before engsys#262 source 1 was
`$CLAUDE_CONFIG_DIR/memory.yml` alone, so an interactive session and every per-session fleet login
read no operator config and fell back to bundled lessons only.

```yaml
repos: [owner/repo]                     # indexed repos; events are read from each repo's own refs
review_markers: ["<!-- local-review-findings -->"]   # extra markers to parse; default regex also applies
trusted_bot_user_ids: []                # numeric bot USER ids (not App ids)
operator_user_ids: []                   # numeric user ids; commit/MEMBER/OWNER operator trust
operator_signing_key_fingerprints: []   # GPG long key ids / 40-hex fingerprints, SSH "SHA256:..." fingerprints; commit operator trust (repo@reviewed-SHA + fleet config only)
trusted_member_user_ids: []             # numeric user ids; MEMBER/OWNER trust (union'd with operator_user_ids)
exclude_class_b_agents: []              # agent types that get Class A only (security agents are always excluded)
high_fanout_globs: []                   # files keyed by symbol instead of path
brief_bytes: 2048
max_events: 20000
publish_role: maintain                  # must stay maintain: any other value refuses --publish (§9)
fleet_memory_pubkeys: {}                # {<fleet>: <base64 raw 32-byte Ed25519 public key>}; fleet config dir ONLY (§9)
```

`fleet_memory_pubkeys` (F5) is read only from the fleet config dir's `memory.yml`, the operator's
reviewed, hash-pinned copy, never from the plugin or repo config. Each value must be exactly 32 bytes
of standard base64 (what `fleet memory-pubkey` prints); a malformed entry is dropped and logged, and a
fleet with no entry is untrusted.

### Commit operator trust, and the real boundary it rests on

A commit is `author_kind: 'operator'` only when ALL of: the commit carries a cryptographically
verified signature (`commit.verification.verified`, resolved via one batched GraphQL `history`
query, never per-commit); the signing **key** (GraphQL `GpgSignature.keyId` / `SshSignature.keyFingerprint`)
is listed in `operator_signing_key_fingerprints` (engsys#187; an empty list trusts no commit, and a
GitHub-signed `wasSignedByGitHub` commit never carries a key); the **committer's** (never the author's — GitHub derives `.author.id`/
the author identity from the commit's author EMAIL, which anyone can set locally) numeric id is
in `operator_user_ids`; and the commit message carries no agent co-author trailer
(`Co-Authored-By:`/`Assisted-by:`/`Generated-by:`, matching Claude, Copilot, Gemini, Antigravity,
Codex, GPT, Opus, Sonnet, DeepSeek, Grok, `noreply@anthropic.com`, or an `@openai.com`/
`@google.com` address). A commit failing any of these is an unlabeled pointer — subject + `#refs`
only, no body.

**The agent-trailer match is defense-in-depth, not the real boundary, and it can never be
exhaustive** against every agent/provider name that exists or will exist. The real boundary is
**key custody**: no operator's commit-signing key (GPG or SSH) may ever be reachable from a
session an agent can drive, and GitHub Codespaces' automatic commit signing must stay **off** for
every operator account — a Codespace that auto-signs commits as the operator would hand an agent
session running inside it a path to a genuinely "verified" signature with no human behind it. If
either of those holds, this trailer regex is unnecessary; if neither holds, it's not sufficient.

`operator_signing_key_fingerprints` is the one allowlist with a narrower source set than the others:
it is read ONLY from the repo's `.claude/memory.yml` at the reviewed SHA (and only for a repo in the
fleet/plugin `repos` allowlist) and the fleet config dir's `memory.yml` — never the plugin config,
never the working tree, never a value carried by a commit or event. Entries are strings (quote
them: an unquoted all-digit fingerprint parses as a lossy YAML number and is dropped). GPG entries
are hex (16-digit long key id, or a 40-hex fingerprint, which matches a signature whose long key id
is its suffix — GitHub reports only the long id, of the signing (sub)key); SSH entries are
`SHA256:<base64>` and compare exactly. Malformed entries are skipped, never wildcard-matched.

`loadConfig()` reads BOTH the repo's own `.claude/memory.yml` (from the reviewed SHA, never the
working tree — §2 rule 4) and the operator's `memory.yml` (source 1 above), and
**merges** them rather than one replacing the other (round 4, Nyx L4): `exclude_class_b_agents`,
`trusted_bot_user_ids`, `operator_user_ids`, and `review_markers` are **unioned** (deduplicated) —
a fleet-wide allowlist/marker set and a repo's own are both meant to apply, not compete. Every
other field is a plain override, with the fleet value winning when both configs set it. A
working-tree-only `.claude/memory.yml` (uncommitted, or committed but not yet pushed to the
reviewed ref) is never read at all — it contributes nothing to either source, so the merged result
is just the fleet config (if any) over the defaults.

## 11. Onboarding

`engsys install` and `/naturalize` take these steps:

1. Create the cache directory lazily, on first use.
2. Seed the overlay template in **both** copy and plugin mode.
3. **Propose** markers and bot user IDs found in recent PRs. The operator confirms them; nothing is
   trusted automatically, and Dependabot and `github-actions` are never proposed.
4. Recommend required human review on the Class A paths.
5. Run `memory-sync --init` (and `--publish` if this host is the writer).

## 12. Verified runtime facts (Claude Code 2.1.285)

- SubagentStart `additionalContext` is delivered to every subagent as a system-role reminder.
- A SubagentStart hook's stdin payload is `{...base, hook_event_name, agent_id, agent_type}` —
  `base` carries `cwd` (and the usual session fields), and `agent_type` is the matcher field (the
  subagent's type, e.g. `engsys:isabelle`). There is **no task-prompt field** at this event — a
  hook cannot read the dispatching task's text. Earlier revisions of
  `subagent-memory-inject.mjs` guessed through `subagent_type`/`tool_input.prompt`/
  `tool_input.description`/etc.; none of those ever matched a real payload and the guessing was
  removed (engsys#140 W1).
- A **teammate** dispatch (the Agent tool with `name`) reaches SubagentStart with the teammate name
  as `agent_type` (e.g. `bert-p2`), not the dispatched `subagent_type`. The PreToolUse record keeps
  both. SubagentStart matches by teammate name first (adopting the recorded `subagent_type` for
  lesson roles and the Class B exclusion), then by type; a start that matches neither gets no
  record, never another parallel dispatch's (engsys#262). Only a bare (un-namespaced) start matches by
  name: a real typed start such as `engsys:nyx` never does, so a teammate named `engsys:nyx` can't make the
  real Nyx adopt its type and lose the Class B exclusion.
- `node:sqlite` with FTS5 and `bm25()` works on Node 22.22.3 (SQLite 3.51.3).
- A naive in-place SQLite rebuild by concurrent processes fails (`database is locked`) and duplicates
  rows. Temp file + rename is safe.

## 13. Tests

- Index: watermark detects an in-place edit; 6 concurrent rebuilds leave one consistent index; the
  index fails open when `node:sqlite` is missing.
- Brief:
  - the byte cap holds and no Class B free text appears in hook output;
  - excluded agents get Class A only;
  - a `security: true` lesson is not suppressed by an unreviewed `supersedes`.
- Sync:
  - App ID ≠ bot user ID is handled;
  - editor ≠ author is handled;
  - minimized and deleted sources produce tombstones;
  - Dependabot is dropped;
  - boundary spoofing is quarantined, and flag-only rules do not quarantine.
- Ref consumer guard: no file outside a short reviewed list names `refs/engsys/memory/*`, and a
  listed consumer calls `verifyMemoryRefTip(` (engsys#188).
- Ref store:
  - a CAS conflict retries and merges;
  - a secret-scan hit rejects the record;
  - compaction keeps the latest version of each key.
- Injection hook returns `{}` on error and on timeout.
