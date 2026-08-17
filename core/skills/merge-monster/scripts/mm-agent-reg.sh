#!/usr/bin/env bash
# mm-agent-reg.sh — subagent spawn registry (docs/subagent-liveness-design.md §3
# Layer 1). One TSV per orchestrator (namespaced by --state-dir, so Merge
# Monster and Maintenance Monster never collide). Rows are keyed by
# (name, gen): `gen` is the attempt generation — the fencing token the recovery
# ladder bumps before any respawn, so a probe-resurrected prior attempt can be
# recognized as fenced. The row's agent_id is the immutable execution identity
# once known (the Agent tool returns it after spawn; update the row then).
#
# Registry file: <state-dir>/agents.tsv, columns:
#   name  gen  status  agent_id  session_id  class  task_ref
#   spawn_epoch  deadline_epoch  extensions  transcript_path
# status: running | done | failed | probe_failed | fenced
#
# Usage:
#   mm-agent-reg.sh spawn  --state-dir DIR --name NAME --task REF --class CLASS \
#                          --deadline-min N [--agent-id ID] [--session-id ID] \
#                          [--transcript PATH]
#   mm-agent-reg.sh update --state-dir DIR --name NAME --gen N --status STATUS \
#                          [--agent-id ID] [--session-id ID] [--transcript PATH]
#   mm-agent-reg.sh extend --state-dir DIR --name NAME --gen N --minutes N
#   mm-agent-reg.sh fence  --state-dir DIR --name NAME [--gen N]
#   mm-agent-reg.sh get    --state-dir DIR --name NAME
#   mm-agent-reg.sh active --state-dir DIR
#
# Semantics:
#   spawn   append a new row. If a row with the same name exists, the new row
#           gets max(gen)+1 (a respawn is always a new generation). Prints the
#           assigned gen — CALLERS MUST RECORD IT and pass it back via --gen.
#   update  rewrite fields on exactly (NAME, --gen). --gen is REQUIRED: a late
#           completion/failure signal always belongs to the generation that
#           produced it, and without the pin it would land on the newest row —
#           a fenced gen-1's "done" arriving after gen-2 spawned must not
#           mark gen-2 done.
#   extend  push (NAME, --gen)'s deadline_epoch out by N minutes (>= 1) and
#           increment extensions. Refuses (exit 3) once extensions >= 1: the
#           design allows exactly one journalled extension before the ladder.
#   fence   mark (NAME, --gen) status=fenced; --gen defaults to the highest
#           generation (fencing is the one mutation that legitimately targets
#           "the current attempt"). The caller respawns only AFTER this
#           succeeds (fence-first rule).
#   get     print all rows for NAME (all generations, oldest first).
#   active  print rows with status=running.
#
# Concurrency: every mutation (spawn/update/extend/fence) runs under a mkdir
# spinlock on <registry>.lock — parallel dispatches from one orchestrator turn
# must not interleave read-modify-write cycles. Reads are lock-free. A lock
# older than 30s is presumed abandoned (crashed mutator) and stolen; mutations
# here are milliseconds, so a 30s-old lock is never live.
set -euo pipefail

CMD="${1:-}"; shift || true
DIR="" NAME="" TASK="" CLASS="" DLMIN="" AGENT_ID="-" SESSION_ID="-" TRANSCRIPT="-" STATUS="" MINUTES="" GENARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --state-dir) DIR="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --task) TASK="$2"; shift 2 ;;
    --class) CLASS="$2"; shift 2 ;;
    --deadline-min) DLMIN="$2"; shift 2 ;;
    --agent-id) AGENT_ID="$2"; shift 2 ;;
    --session-id) SESSION_ID="$2"; shift 2 ;;
    --transcript) TRANSCRIPT="$2"; shift 2 ;;
    --status) STATUS="$2"; shift 2 ;;
    --minutes) MINUTES="$2"; shift 2 ;;
    --gen) GENARG="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$DIR" ] || { echo "usage: mm-agent-reg.sh <spawn|update|extend|fence|get|active> --state-dir DIR ..." >&2; exit 2; }
REG="$DIR/agents.tsv"
mkdir -p "$DIR"; touch "$REG"

# --- interprocess lock for mutations (mkdir is atomic on POSIX) --------------
LOCKDIR="$REG.lock"
lock_mtime() {
  m=$(stat -c %Y "$LOCKDIR" 2>/dev/null || stat -f %m "$LOCKDIR" 2>/dev/null || echo "")
  case "$m" in '' | *[!0-9]*) echo 0 ;; *) echo "$m" ;; esac
}
acquire_lock() {
  tries=0
  until mkdir "$LOCKDIR" 2>/dev/null; do
    tries=$((tries + 1))
    if [ "$tries" -gt 150 ]; then # ~30s of spinning
      echo "error: could not acquire registry lock $LOCKDIR after 30s" >&2
      exit 4
    fi
    # Steal a lock older than 30s — its holder crashed mid-mutation. Steal via
    # atomic mv, NOT rmdir: with rmdir, two waiters can both pass the age check
    # and the slower one would delete the lock the faster one just re-created.
    # mv renames the specific stale dir; exactly one stealer wins, the loser's
    # mv fails harmlessly, and everyone re-races the mkdir.
    LM=$(lock_mtime)
    if [ "$LM" -gt 0 ] && [ $(($(date +%s) - LM)) -gt 30 ]; then
      if mv "$LOCKDIR" "$LOCKDIR.stale.$$" 2>/dev/null; then
        rmdir "$LOCKDIR.stale.$$" 2>/dev/null || true
      fi
      continue
    fi
    sleep 0.2
  done
  trap 'rmdir "$LOCKDIR" 2>/dev/null || true' EXIT
}
case "$CMD" in spawn | update | extend | fence) acquire_lock ;; esac

# resolve the generation a mutation targets: --gen if given (must exist),
# else the highest generation of NAME
target_gen() { # $1 = "required" to refuse a missing --gen
  if [ -n "$GENARG" ]; then
    awk -F'\t' -v n="$NAME" -v g="$GENARG" '$1==n && ($2+0)==(g+0) {f=1} END {exit f?0:1}' "$REG" \
      || { echo "error: no row ($NAME, gen=$GENARG)" >&2; exit 3; }
    echo "$GENARG"
  else
    if [ "${1:-}" = "required" ]; then
      echo "error: --gen is required for $CMD (pass the gen printed by spawn — a late signal must never land on a newer generation)" >&2
      exit 2
    fi
    max_gen
  fi
}

# Registry names must be TAB-free and non-empty; they key every row.
check_name() {
  [ -n "$NAME" ] || { echo "error: --name required" >&2; exit 2; }
  case "$NAME" in *"$(printf '\t')"* | *"|"*) echo "error: name contains a tab or pipe" >&2; exit 2 ;; esac
}

# Every serialized field must be free of the TSV's structural characters —
# a tab/newline/CR in a task ref or transcript path would corrupt the row.
check_field() { # $1 = field label, $2 = value
  case "$2" in
    *"$(printf '\t')"* | *"$(printf '\r')"* | *"
"*)
      echo "error: $1 contains a tab/newline/CR" >&2; exit 2 ;;
  esac
}
check_fields() {
  check_field task "$TASK"; check_field class "$CLASS"
  check_field agent-id "$AGENT_ID"; check_field session-id "$SESSION_ID"
  check_field transcript "$TRANSCRIPT"
  if [ -n "$STATUS" ]; then
    case "$STATUS" in
      running | done | failed | probe_failed | fenced) ;;
      *) echo "error: --status must be one of running|done|failed|probe_failed|fenced" >&2; exit 2 ;;
    esac
  fi
}

# highest generation recorded for NAME (0 if none)
max_gen() {
  awk -F'\t' -v n="$NAME" '$1==n && ($2+0)>m {m=$2+0} END {print m+0}' "$REG"
}

# atomic rewrite: awk PROG over the registry with common vars bound
rewrite() { # $1 = awk program acting on the full file
  local tmp
  tmp="$(mktemp "$REG.XXXXXX")"
  awk -F'\t' -v OFS='\t' -v n="$NAME" -v g="$1" \
      -v st="${STATUS:-}" -v aid="$AGENT_ID" -v sid="$SESSION_ID" -v tp="$TRANSCRIPT" \
      -v mins="${MINUTES:-0}" -v now="$(date +%s)" "$2" "$REG" > "$tmp"
  mv "$tmp" "$REG"
}

case "$CMD" in
  spawn)
    check_name
    check_fields
    [ -n "$TASK" ] && [ -n "$CLASS" ] && [ -n "$DLMIN" ] || { echo "error: spawn needs --task --class --deadline-min" >&2; exit 2; }
    PREV_GEN=$(max_gen)
    if [ "$PREV_GEN" -gt 0 ]; then
      # Fence-first, enforced here and not just in the skill text: a new
      # generation may only follow a terminal or fenced predecessor. A prior
      # gen still running (or parked probe_failed — not yet classified dead)
      # must be fenced before a respawn, or two live attempts can race.
      PREV_STATUS=$(awk -F'\t' -v n="$NAME" -v g="$PREV_GEN" '$1==n && ($2+0)==g {print $3; exit}' "$REG")
      case "$PREV_STATUS" in
        fenced | done | failed) ;;
        *)
          echo "error: prior generation ($NAME, gen=$PREV_GEN) is '$PREV_STATUS' — fence it (or close it done/failed) before respawning" >&2
          exit 3 ;;
      esac
    fi
    GEN=$(( PREV_GEN + 1 ))
    NOW=$(date +%s)
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$NAME" "$GEN" running "$AGENT_ID" "$SESSION_ID" "$CLASS" "$TASK" \
      "$NOW" "$(( NOW + DLMIN * 60 ))" 0 "$TRANSCRIPT" >> "$REG"
    echo "spawned: $NAME gen=$GEN deadline=+${DLMIN}m"
    ;;
  update)
    check_name
    check_fields
    [ -n "$STATUS" ] || [ "$AGENT_ID" != "-" ] || [ "$SESSION_ID" != "-" ] || [ "$TRANSCRIPT" != "-" ] \
      || { echo "error: update needs --status and/or an identity field" >&2; exit 2; }
    GEN=$(target_gen required)
    rewrite "$GEN" '
      $1==n && $2==g {
        if (st != "") $3 = st
        if (aid != "-") $4 = aid
        if (sid != "-") $5 = sid
        if (tp  != "-") $11 = tp
      } { print }'
    echo "updated: $NAME gen=$GEN${STATUS:+ status=$STATUS}"
    ;;
  extend)
    check_name
    [ -n "$MINUTES" ] && [ "$MINUTES" -ge 1 ] 2>/dev/null || { echo "error: extend needs --minutes >= 1 (a zero extension cannot re-arm the OVERDUE latch)" >&2; exit 2; }
    GEN=$(target_gen required)
    EXT=$(awk -F'\t' -v n="$NAME" -v g="$GEN" '$1==n && $2==g {print $10}' "$REG")
    if [ "${EXT:-0}" -ge 1 ]; then
      echo "refused: $NAME gen=$GEN already extended once — escalate, don't extend again" >&2
      exit 3
    fi
    rewrite "$GEN" '
      $1==n && $2==g { $9 = $9 + mins*60; $10 = $10 + 1 } { print }'
    echo "extended: $NAME gen=$GEN by ${MINUTES}m (1 of 1 allowed)"
    ;;
  fence)
    check_name
    GEN=$(target_gen); [ "$GEN" -gt 0 ] || { echo "error: no row for $NAME" >&2; exit 3; }
    rewrite "$GEN" '
      $1==n && $2==g { $3 = "fenced" } { print }'
    echo "fenced: $NAME gen=$GEN — a respawn may now take gen=$((GEN+1))"
    ;;
  get)
    check_name
    awk -F'\t' -v n="$NAME" '$1==n' "$REG"
    ;;
  active)
    awk -F'\t' '$3=="running"' "$REG"
    ;;
  *)
    echo "usage: mm-agent-reg.sh <spawn|update|extend|fence|get|active> --state-dir DIR ..." >&2
    exit 2
    ;;
esac
