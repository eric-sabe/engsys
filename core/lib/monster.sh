#!/usr/bin/env bash
# monster.sh: source me. Shared helpers for the monsters' watch buses, ticks and heartbeats
# (merge-monster, maintenance-monster, resource-broker).
#
#   monster_sha256 FILE                 the file's SHA-256 (hex), portable across macOS and Linux
#   monster_cfg_scalar FILE KEY         a top-level `key: value` from a monster yml (quotes and a trailing
#                                       comment stripped); empty when absent. The monsters' configs are
#                                       flat enough for this; nested keys use the reader below.
#   monster_cfg_child FILE PARENT KEY   `parent:\n  key: value` (one level down), same rules
#   monster_cfg_list_empty FILE PARENT KEY
#                                       exit 0 when PARENT.KEY is absent, null, empty or `[]`; exit 1 when it
#                                       holds a flow list with items or a block list (`- item` lines)
#   monster_pulse_max PULSE HB_MINUTES [STALE_LOCK_MINUTES]
#                                       prints `<seconds>s<TAB><warning>`: the keepalive's --pulse-max. PULSE
#                                       when set (a bare number is minutes; ms, s, m and h units), else 2.25 x
#                                       HB_MINUTES, else 20m; with STALE_LOCK_MINUTES, held between the tick
#                                       (hb + 2m) and stale - 10m - 0.75 x hb - 1m, so the lease always lapses
#                                       before the heartbeat reads stale. The warning (empty when none) says
#                                       what was clamped, or that the two settings cannot both hold
#   monster_snapshot_lines              stdin JSON -> one sorted compact line per item (an array's elements;
#                                       an object's scalars, its arrays' elements and its `items` lists, each
#                                       tagged with the key), so a delta names what changed
#   monster_delta DIR                   stdin lines -> compare their SHA-256 with DIR/last-snapshot.sha; when it
#                                       differs, print `+ line` / `- line` against DIR/last-snapshot.lines and
#                                       store the new pair. Prints nothing when unchanged.
#   monster_heartbeat_mark STATE_DIR    record that a heartbeat was written now (.watch/last-heartbeat)
#   monster_heartbeat_due STATE_DIR MIN exit 0 when no heartbeat was written in the last 0.75 x MIN minutes
#   monster_is_active STATE_DIR         exit 0 when something is in flight: a non-empty <state_dir>/active or a
#                                       `running` row in <state_dir>/agents.tsv
#   monster_sessions_dir                where the SessionStart hook records each launched session's transcript
#   monster_transcript [PATH]           PATH when given, else the transcript recorded for ENGSYS_SESSION by THIS
#                                       launch (the record's run = ENGSYS_SESSION_RUN when that is set); empty
#                                       when unknown, from another launch, or not a regular file
#   monster_handback_events STATE_DIR   print `HANDBACK_INCOMPLETE <agent> (<id>): <remains>` once for each INCOMPLETE
#                                       hand-back the handback-guard hook logged for this session and launch
#                                       (<sessions dir>/[<fleet>.]<session>.handbacks.jsonl, filtered on
#                                       ENGSYS_SESSION_RUN; offset in .watch/handbacks.off). The monsters' net
#                                       in place of the Stop-time block (engsys#126 review)
#   monster_handback_prune STATE_DIR    drop other launches' lines from that log (the buses, once at start)
#   monster_context_tokens TRANSCRIPT   the main thread's last assistant usage (input + cache creation + cache
#                                       read), read from the last 64 KB of the transcript; empty when none
#   monster_review_label REPO [CONFIG]  sets MONSTER_REVIEW_LABEL, the security-review request label the merge preflight
#                                       names (core/lib/security-sensitive.mjs review-label: the discovered merge configs,
#                                       CONFIG as one more source; engsys#231), and MONSTER_REVIEW_LABEL_WARN: empty, or
#                                       why it could not be resolved (a cross-config conflict, an unreadable config). Then
#                                       the label falls back to security-review-requested so the watch keeps running,
#                                       and the caller must say so loudly (preflight itself fails closed on the same
#                                       config, so no PR passes meanwhile)
#   monster_rotation_status STATE_DIR STATUS THRESHOLD [TRANSCRIPT]
#                                       sets MONSTER_STATUS, the heartbeat status to write: over THRESHOLD
#                                       tokens (0 = never) with nothing active, `rotation requested — ctx <N>k`,
#                                       sticky for that transcript (.watch/rotation-requested) so every later
#                                       heartbeat of the same session repeats it; else STATUS unchanged. A
#                                       status that already ends the session (rotation, session end, handover)
#                                       is never replaced. MONSTER_ROTATION=1 when it is the rotation status;
#                                       MONSTER_CTX = the tokens read (empty when unknown).

# When GH_APP_ENV_FILE is set (fleet GitHub App bot identity), keep core/fleet/identity/bin at the
# front of PATH if a login subshell (e.g. under HARNESS=copilot or antigravity) prepended brew/system dirs.
if [ -n "${GH_APP_ENV_FILE:-}" ]; then
  _monster_id_bin="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/fleet/identity/bin"
  if [ -x "$_monster_id_bin/gh" ]; then
    case ":$PATH:" in
      ":$_monster_id_bin:"*) ;;
      *":$_monster_id_bin:"*)
        PATH="$_monster_id_bin:${PATH//:$_monster_id_bin/}"
        export PATH ;;
    esac
  fi
  unset _monster_id_bin
fi

monster_review_label() {
  local out rc=0 why
  MONSTER_REVIEW_LABEL="" MONSTER_REVIEW_LABEL_WARN=""
  out=$(node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/security-sensitive.mjs" review-label --repo "$1" ${2:+--config "$2"} 2>&1) || rc=$?
  if [ "$rc" = 0 ] && [ -n "$out" ]; then MONSTER_REVIEW_LABEL="$out"; return 0; fi
  MONSTER_REVIEW_LABEL=security-review-requested
  why=$(printf '%s' "$out" | jq -r '.reason // empty' 2>/dev/null || true)
  [ -n "$why" ] || why=$(printf '%s' "${out:-exit $rc}" | tr '\n' ' ' | head -c 200)
  MONSTER_REVIEW_LABEL_WARN="security review label unresolved (${why:0:220}): watching the default 'security-review-requested'; fix security_review_label in the merge configs"
  return 0
}

monster_sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else sha256sum "$1" | awk '{print $1}'; fi
}

# _monster_unquote: strip a trailing comment and surrounding quotes from a yml scalar.
_monster_unquote() {
  sed -e 's/[[:space:]]#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
    -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

monster_cfg_scalar() {
  [ -f "$1" ] || return 0
  awk -v k="$2" 'index($0, k ":") == 1 { sub("^" k ":", ""); print; exit }' "$1" | _monster_unquote
}

monster_cfg_child() {
  [ -f "$1" ] || return 0
  awk -v p="$2" -v k="$3" '
    index($0, p ":") == 1 { inp = 1; next }
    inp && /^[^[:space:]#]/ { inp = 0 }
    inp && $0 ~ "^[[:space:]]+" k ":" { sub("^[[:space:]]+" k ":", ""); print; exit }' "$1" | _monster_unquote
}

monster_cfg_list_empty() {
  [ -f "$1" ] || return 0
  local verdict
  verdict=$(awk -v p="$2" -v k="$3" '
    function strip(s) { sub(/[[:space:]]#.*$/, "", s); gsub(/^[[:space:]]+|[[:space:]]+$/, "", s); return s }
    index($0, p ":") == 1 { inp = 1; next }
    inp && /^[^[:space:]#]/ { inp = 0 }
    inp && !ink && $0 ~ "^[[:space:]]+" k ":" {
      v = $0; sub("^[[:space:]]+" k ":", "", v); v = strip(v)
      if (v == "" ) { ink = 1; match($0, /^[[:space:]]+/); kind = RLENGTH; next }
      if (v == "[]" || v == "~" || v == "null" || v ~ /^\[[[:space:]]*\]$/) { print "empty"; exit }
      print "items"; exit
    }
    ink {
      if ($0 ~ /^[[:space:]]*(#.*)?$/) next
      match($0, /^[[:space:]]*/)
      if (RLENGTH >= kind && $0 ~ /^[[:space:]]*-/) { print "items"; exit }
      print "empty"; exit
    }' "$1")
  [ "$verdict" != items ]
}

monster_pulse_max() {
  local pulse="$1" hb="$2" stale="${3:-}" want="" n warn="" cap floor v
  case "$hb" in '' | 0 | *[!0-9]*) hb="" ;; esac
  case "$stale" in '' | 0 | *[!0-9]*) stale="" ;; esac
  if [ -n "$pulse" ]; then
    case "$pulse" in
      *[!0-9a-z]* | '') ;;
      *[0-9]) want=$((pulse * 60)) ;;
      *[0-9]ms) n="${pulse%ms}"; case "$n" in *[!0-9]*) ;; *) want=$(((n + 999) / 1000)) ;; esac ;;
      *[0-9]s) n="${pulse%s}"; case "$n" in *[!0-9]*) ;; *) want="$n" ;; esac ;;
      *[0-9]m) n="${pulse%m}"; case "$n" in *[!0-9]*) ;; *) want=$((n * 60)) ;; esac ;;
      *[0-9]h) n="${pulse%h}"; case "$n" in *[!0-9]*) ;; *) want=$((n * 3600)) ;; esac ;;
    esac
    [ -n "$want" ] || warn="pulse_max '$pulse' is not minutes or a duration (90, 45m, 1350s, 1h, 500ms); using the default"
  fi
  if [ -z "$want" ]; then
    if [ -n "$hb" ]; then v=$((hb * 135)); else v=1200; fi # 2.25 x heartbeat_minutes, else the keepalive's 20m
  else
    v="$want"
  fi
  # The invariant (engsys#125 review): the lease must lapse before the heartbeat reads stale, or a human
  # following "stale heartbeat => merge by hand" races a monster that still holds a live lease. Only the
  # tick's and the heartbeat's renew record a pulse (`renew --pulse`; a fence or a bare renew never does,
  # engsys#137 review W1: a fenced act between ticks would otherwise pulse with a heartbeat up to 1.75 x hb
  # old). So the last pulse P comes with a heartbeat no older than 0.75 x hb (the tick writes one when the
  # last is older); the keepalive renews until P + pulse_max,
  # and the lease (TTL 10m) lapses by P + pulse_max + 10m. So pulse_max <= stale - 10m - 0.75 x hb - 1m. And
  # it must outlast the tick (hb + 2m), or the keepalive stops between two ticks.
  if [ -n "$hb" ] && [ -n "$stale" ]; then
    cap=$(((stale - 11) * 60 - hb * 45)); floor=$((hb * 60 + 120))
    if [ "$cap" -lt "$floor" ]; then
      warn="stale_lock_minutes $stale is too short for heartbeat_minutes $hb (it needs >= $(((175 * hb + 1300 + 99) / 100))): the lease can outlive a stale heartbeat; pulse_max set to $((floor / 60))m, just over the tick. Raise stale_lock_minutes or lower heartbeat_minutes"
      v="$floor"
    else
      [ "$v" -le "$cap" ] || { [ -z "$want" ] || warn="pulse_max ${pulse} clamped to $((cap / 60))m: the lease must lapse before the heartbeat is stale (stale_lock_minutes $stale - 10m lease - 0.75 x heartbeat_minutes $hb - 1m)"; v="$cap"; }
      [ "$v" -ge "$floor" ] || { warn="pulse_max ${pulse} raised to $((floor / 60))m: it must outlast the tick (heartbeat_minutes $hb + 2m)"; v="$floor"; }
    fi
  elif [ -n "$hb" ] && [ "$v" -lt $((hb * 60 + 120)) ]; then
    warn="pulse_max ${pulse} does not outlast the tick (heartbeat_minutes $hb + 2m): the keepalive will stop between ticks"
  fi
  printf '%ss\t%s\n' "$v" "$warn"
}

monster_snapshot_lines() {
  jq -c '
    def tag($k): if type == "object" then {k: $k} + . else {k: $k, v: .} end;
    if type == "array" then .[]
    elif type == "object" then
      to_entries[] | .key as $k | .value
      | if type == "array" then .[] | tag($k)
        elif type == "object" and ((.items | type) == "array") then (del(.items) | tag($k)), (.items[] | tag($k))
        else tag($k) end
    else . end' | LC_ALL=C sort
}

monster_delta() {
  local dir="$1" new sha old
  mkdir -p "$dir"
  new="$dir/last-snapshot.new"
  LC_ALL=C sort >"$new" # comm needs sorted input in one collation; never trust the caller's order
  sha=$(monster_sha256 "$new")
  old=$(cat "$dir/last-snapshot.sha" 2>/dev/null || true)
  if [ "$sha" = "$old" ] && [ -f "$dir/last-snapshot.lines" ]; then rm -f "$new"; return 0; fi
  touch "$dir/last-snapshot.lines"
  LC_ALL=C sort -o "$dir/last-snapshot.lines" "$dir/last-snapshot.lines" # a file from an older version
  LC_ALL=C comm -23 "$dir/last-snapshot.lines" "$new" | sed 's/^/- /'
  LC_ALL=C comm -13 "$dir/last-snapshot.lines" "$new" | sed 's/^/+ /'
  mv "$new" "$dir/last-snapshot.lines"
  printf '%s\n' "$sha" >"$dir/last-snapshot.sha"
}

monster_heartbeat_mark() {
  mkdir -p "$1/.watch" 2>/dev/null && date +%s >"$1/.watch/last-heartbeat" 2>/dev/null
  return 0
}

monster_heartbeat_due() {
  local last min="$2"
  case "$min" in '' | 0 | *[!0-9]*) min=10 ;; esac
  last=$(cat "$1/.watch/last-heartbeat" 2>/dev/null || true)
  case "$last" in '' | *[!0-9]*) return 0 ;; esac
  [ $(($(date +%s) - last)) -ge $((min * 45)) ] # 0.75 x min minutes, in seconds
}

monster_is_active() {
  [ -s "$1/active" ] && [ -n "$(tr -d '[:space:]' <"$1/active")" ] && return 0
  [ -f "$1/agents.tsv" ] && awk -F'\t' '$3 == "running" { f = 1 } END { exit !f }' "$1/agents.tsv" && return 0
  return 1
}

monster_sessions_dir() {
  printf '%s\n' "${ENGSYS_SESSIONS_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/engsys/sessions}"
}

monster_transcript() {
  local t="${1:-}" s="${ENGSYS_SESSION:-}" f
  if [ -z "$t" ]; then
    case "$s" in '' | *[!A-Za-z0-9._-]*) return 0 ;; esac
    f="$(monster_sessions_dir)/${FLEET_ID:+$FLEET_ID.}$s.json"
    [ -f "$f" ] || return 0
    # Only this launch's record (engsys#125 review): a record left by an earlier launch (the hook failed
    # this time) names the old, full transcript, and would re-request rotation on every relaunch.
    t=$(jq -r --arg run "${ENGSYS_SESSION_RUN:-}" 'select($run == "" or .run == $run) | .transcript_path // empty' "$f" 2>/dev/null || true)
  fi
  case "$t" in /*) ;; *) return 0 ;; esac
  [ -f "$t" ] && [ ! -L "$t" ] && printf '%s\n' "$t"
  return 0
}

# _monster_lock LOCKDIR / _monster_unlock LOCKDIR: the scan.lock pattern (mm-agent-watch.sh): mkdir is the
# mutex, a lock older than 30 s is a crashed holder and is reclaimed under `$lock.reclaim` after re-verifying age.
# Gives up after ~5 s (exit 1): the caller skips this pass and the next poll catches up. Shared at `<file>.lock`
# with relayHandback in handback-guard.mjs so a SubagentStop append and monster_handback_prune never race (engsys#138).
_monster_mtime() {
  local m
  m=$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0)
  case "$m" in '' | *[!0-9]*) m=0 ;; esac
  printf '%s\n' "$m"
}
_monster_lock() {
  local l="$1" r="$1.reclaim" tries=0 lm rm_t
  until mkdir "$l" 2>/dev/null; do
    tries=$((tries + 1)); [ "$tries" -le 25 ] || return 1
    lm=$(_monster_mtime "$l")
    if [ "$lm" -gt 0 ] && [ $(($(date +%s) - lm)) -gt 30 ]; then
      rm_t=$(_monster_mtime "$r")
      [ "$rm_t" -gt 0 ] && [ $(($(date +%s) - rm_t)) -gt 30 ] && rmdir "$r" 2>/dev/null
      if mkdir "$r" 2>/dev/null; then
        lm=$(_monster_mtime "$l")
        if [ "$lm" -gt 0 ] && [ $(($(date +%s) - lm)) -gt 30 ]; then
          mv "$l" "$l.stale.$$" 2>/dev/null && rmdir "$l.stale.$$" 2>/dev/null
        fi
        rmdir "$r" 2>/dev/null
        continue
      fi
    fi
    sleep 0.2
  done
}
_monster_unlock() { rmdir "$1" 2>/dev/null || true; }
_monster_has_handback() {
  local f="$1" p
  [ -f "$f" ] && return 0
  for p in "$f".pending.*; do [ -f "$p" ] && return 0; done
  return 1
}
_monster_drain_pending() {
  local f="$1" p d
  for p in "$f".pending.*; do
    [ -f "$p" ] || continue
    d="$p.draining.$$"
    if mv "$p" "$d" 2>/dev/null; then
      if cat "$d" >>"$f"; then
        chmod 600 "$f" 2>/dev/null || true
        rm -f "$d"
      fi
    fi
  done
}

monster_handback_events() {
  local dir="$1" s="${ENGSYS_SESSION:-}" f lock size off chunk
  case "$s" in '' | *[!A-Za-z0-9._-]*) return 0 ;; esac
  f="$(monster_sessions_dir)/${FLEET_ID:+$FLEET_ID.}$s.handbacks.jsonl"
  _monster_has_handback "$f" || return 0
  lock="$f.lock"
  mkdir -p "$dir/.watch" 2>/dev/null || return 0
  # The bus, the tick and the SubagentStop hook share $f.lock: one reader/writer at a time (engsys#137, #138).
  _monster_lock "$lock" || return 0
  _monster_drain_pending "$f"
  [ -f "$f" ] || { _monster_unlock "$lock"; return 0; }
  size=$(wc -c <"$f" 2>/dev/null | tr -d ' ')
  case "$size" in '' | *[!0-9]*) size=0 ;; esac
  off=$(cat "$dir/.watch/handbacks.off" 2>/dev/null || true)
  case "$off" in '' | *[!0-9]*) off=0 ;; esac
  [ "$off" -le "$size" ] || off=0 # the log was replaced
  if [ "$size" -gt "$off" ]; then
    chunk=$(mktemp "$dir/.watch/handbacks.chunk.XXXXXX") || { _monster_unlock "$lock"; return 0; }
    # Complete lines only: a line still being appended stays for the next read (the offset stops before it).
    tail -c +"$((off + 1))" "$f" | head -c "$((size - off))" >"$chunk"
    if [ "$(tail -c 1 "$chunk" | od -An -tx1 | tr -d ' \n')" != 0a ]; then
      sed '$d' "$chunk" >"$chunk.done" && mv "$chunk.done" "$chunk"
    fi
    jq -R -r --arg run "${ENGSYS_SESSION_RUN:-}" '
      fromjson? | select($run == "" or .run == $run)
      | "HANDBACK_INCOMPLETE \(.agent_type) (\(.agent_id)): \(.remains)" | .[0:300]' <"$chunk" 2>/dev/null
    size=$((off + $(wc -c <"$chunk" | tr -d ' ')))
    rm -f "$chunk"
  fi
  printf '%s\n' "$size" >"$dir/.watch/handbacks.off"
  _monster_unlock "$lock"
}

# monster_handback_prune: drop the hand-back log's lines from other launches (run != ENGSYS_SESSION_RUN), so
# the log never grows across relaunches. The buses run it once at start, before their first read; the
# offset file is reset with it, since the kept lines are renumbered.
monster_handback_prune() {
  local dir="$1" s="${ENGSYS_SESSION:-}" run="${ENGSYS_SESSION_RUN:-}" f lock tmp off
  case "$s" in '' | *[!A-Za-z0-9._-]*) return 0 ;; esac
  [ -n "$run" ] || return 0
  f="$(monster_sessions_dir)/${FLEET_ID:+$FLEET_ID.}$s.handbacks.jsonl"
  _monster_has_handback "$f" || return 0
  lock="$f.lock"
  mkdir -p "$dir/.watch" 2>/dev/null || return 0
  _monster_lock "$lock" || return 0
  _monster_drain_pending "$f"
  [ -f "$f" ] || { _monster_unlock "$lock"; return 0; }
  tmp=$(mktemp "$f.XXXXXX") || { _monster_unlock "$lock"; return 0; }
  off=$(cat "$dir/.watch/handbacks.off" 2>/dev/null || true)
  case "$off" in '' | *[!0-9]*) off=0 ;; esac
  # Keep this launch's complete lines. The new offset is the size of the kept lines that lay before the old
  # offset (already relayed), so nothing this launch logged is lost or relayed twice.
  jq -R -c --arg run "$run" 'fromjson? | select(.run == $run)' "$f" >"$tmp" 2>/dev/null
  if [ "$(wc -c <"$tmp" | tr -d ' ')" -lt "$(wc -c <"$f" | tr -d ' ')" ]; then
    head -c "$off" "$f" | jq -R -c --arg run "$run" 'fromjson? | select(.run == $run)' 2>/dev/null | wc -c | tr -d ' ' >"$dir/.watch/handbacks.off"
    chmod 600 "$tmp" 2>/dev/null
    mv "$tmp" "$f"
  else
    rm -f "$tmp"
  fi
  _monster_unlock "$lock"
}

monster_context_tokens() {
  [ -f "$1" ] || return 0
  tail -c 65536 "$1" 2>/dev/null | jq -R -r '
    fromjson? | select(.type == "assistant" and (.isSidechain | not) and (.message.usage | type) == "object")
    | .message.usage | (.input_tokens // 0) + (.cache_creation_input_tokens // 0) + (.cache_read_input_tokens // 0)' \
    2>/dev/null | tail -n 1
}

# monster_rotate_tokens [CONFIGURED] [COMPACT_WINDOW]: prints `<tokens><TAB><warning>` (engsys#144).
#   Default (when CONFIGURED is unset): 70% of the effective compaction window — CLAUDE_CODE_AUTO_COMPACT_WINDOW
#   when set (e.g. 250000 -> 175000), else 1000000 when the model has `[1m]` (-> 700000), else 200000 (-> 140000).
#   0 = off. When a configured value is >= the effective compaction point (CLAUDE_CODE_AUTO_COMPACT_WINDOW when
#   set), emits a warning and clamps to window * 7 / 10 so rotation fires before auto-compaction.
monster_rotate_tokens() {
  local cfg="${1:-}" win="${2-${CLAUDE_CODE_AUTO_COMPACT_WINDOW:-}}" eff_win=200000 def warn="" v=""
  case "$win" in
    '' | *[!0-9]*) win="" ;;
    *) win="${win#"${win%%[!0]*}"}" ;;
  esac
  if [ -n "$win" ]; then
    eff_win="$win"
  else
    case "${ANTHROPIC_MODEL:-}${CLAUDE_MODEL:-}" in *"[1m]"*) eff_win=1000000 ;; esac
  fi
  def=$((eff_win * 7 / 10))
  case "$cfg" in
    '') v="$def" ;;
    *[!0-9]*)
      warn="rotate_context_tokens '$cfg' is not a non-negative integer; using the default ($def)"
      v="$def" ;;
    *)
      v="${cfg#"${cfg%%[!0]*}"}"
      if [ -z "$v" ]; then
        v=0
      elif [ -n "$win" ] && [ "$v" -ge "$win" ]; then
        warn="rotate_context_tokens $cfg >= CLAUDE_CODE_AUTO_COMPACT_WINDOW $win (the session compacts before reaching it); clamped to $def"
        v="$def"
      fi ;;
  esac
  printf '%s\t%s\n' "$v" "$warn"
}

monster_rotation_status() {
  local dir="$1" threshold="${3:-}" t sticky tokens rot_out rot_warn
  MONSTER_STATUS="$2" MONSTER_ROTATION=0 MONSTER_CTX=""
  case "$MONSTER_STATUS" in *[Rr]otation\ requested* | *[Ss]ession\ end* | *[Hh]andover*) return 0 ;; esac
  rot_out="$(monster_rotate_tokens "$threshold")"
  threshold="${rot_out%%$'\t'*}"
  rot_warn="${rot_out#*$'\t'}"
  if [ -n "$rot_warn" ] && [ ! -f "$dir/.watch/rotate-warned" ]; then
    mkdir -p "$dir/.watch" 2>/dev/null && : >"$dir/.watch/rotate-warned"
    printf 'CONFIG_WARNING: %s\n' "$rot_warn" >&2
  fi
  t=$(monster_transcript "${4:-}")
  [ -n "$t" ] || return 0
  sticky="$dir/.watch/rotation-requested"
  if [ -f "$sticky" ] && [ "$(sed -n 1p "$sticky")" = "$t" ]; then
    MONSTER_STATUS=$(sed -n 2p "$sticky"); MONSTER_ROTATION=1; return 0
  fi
  tokens=$(monster_context_tokens "$t")
  case "$tokens" in '' | *[!0-9]*) return 0 ;; esac
  MONSTER_CTX="$tokens"
  if [ "$threshold" -gt 0 ] && [ "$tokens" -gt "$threshold" ] && ! monster_is_active "$dir"; then
    MONSTER_STATUS="rotation requested — ctx $((tokens / 1000))k"
    MONSTER_ROTATION=1
    mkdir -p "$dir/.watch" && printf '%s\n%s\n' "$t" "$MONSTER_STATUS" >"$sticky"
  fi
  return 0
}

# monster_stop_keepalive STATE_DIR ROLE: stop the detached keepalive recorded in
# <state_dir>/baton-<role>.keepalive.pid (verify pid + start time when recorded) and remove the pidfile.
monster_stop_keepalive() {
  local state_dir="$1" role="$2" pidfile ka_pid="" ka_start="" cur_start="" i
  pidfile="$state_dir/baton-$role.keepalive.pid"
  [ -f "$pidfile" ] || return 0
  IFS='|' read -r ka_pid ka_start _ <"$pidfile" || true
  case "$ka_pid" in
    '' | *[!0-9]*)
      rm -f "$pidfile" 2>/dev/null || return 1
      return 0 ;;
  esac
  if kill -0 "$ka_pid" 2>/dev/null; then
    cur_start=$(ps -o lstart= -p "$ka_pid" 2>/dev/null | awk '{$1=$1; print}' || true)
    if [ -n "$ka_start" ] && [ -n "$cur_start" ] && [ "$cur_start" != "$ka_start" ]; then
      # PID was reused by a different process; the keepalive already exited.
      rm -f "$pidfile" 2>/dev/null || return 1
      return 0
    fi
    if [ -n "$ka_start" ] && [ -z "$cur_start" ]; then
      # ps could not read lstart while kill -0 succeeded (or raced with exit); re-check kill -0 before failing closed.
      if kill -0 "$ka_pid" 2>/dev/null; then
        return 1
      fi
      rm -f "$pidfile" 2>/dev/null || return 1
      return 0
    fi
    kill "$ka_pid" 2>/dev/null || true
    for i in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$ka_pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$ka_pid" 2>/dev/null; then
      kill -9 "$ka_pid" 2>/dev/null || true
    fi
  fi
  rm -f "$pidfile" 2>/dev/null || return 1
  return 0
}

# monster_baton_rotate ROLE HB_SCRIPT BATON_LIB ARGS...: scripted rotation sequence (engsys#116):
#   1. Writes the final ledger heartbeat (`rotation requested`).
#   2. Stops the keepalive (before releasing so a concurrent keepalive tick cannot renew after release).
#   3. Releases the baton (`--reason rotation`).
#   4. Exits non-zero, with a clear message, if any step fails.
monster_baton_rotate() {
  local role="$1" hb_script="$2" baton_lib="$3"
  shift 3
  local repo="" state_dir="" ledger="" session="" status="rotation requested" if_due="60m"
  while [ $# -gt 0 ]; do
    case "$1" in
      --repo) repo="${2:-}"; shift 2 ;;
      --state-dir) state_dir="${2:-}"; shift 2 ;;
      --state-dir=*) state_dir="${1#--state-dir=}"; shift ;;
      --ledger | --issue) ledger="${2:-}"; shift 2 ;;
      --session) session="${2:-}"; shift 2 ;;
      --status) status="${2:-}"; shift 2 ;;
      --if-due) if_due="${2:-}"; shift 2 ;;
      *) echo "baton rotate ($role): unknown arg: $1" >&2; return 2 ;;
    esac
  done
  if [ -z "$repo" ] || [ -z "$state_dir" ] || [ -z "$ledger" ]; then
    echo "usage: $(basename "$hb_script" | sed 's/heartbeat/baton/') rotate --repo owner/name --state-dir DIR --ledger N [--session NAME] [--status text]" >&2
    return 2
  fi
  case "$status" in
    *[Rr]otation\ requested*) ;;
    '') status="rotation requested" ;;
    *) status="rotation requested — $status" ;;
  esac

  local hb_rc=0 hb_out="" rel_rc=0 rel_out="" ka_rc=0 err_msg=""
  # Step 1: Write final ledger heartbeat ("rotation requested"). --if-due 60m checks the held baton locally
  # without extending the GitHub lease TTL right before step 2 releases it; the ledger issue edit always runs.
  hb_out=$(bash "$hb_script" --repo "$repo" --issue "$ledger" --state-dir "$state_dir" \
    --if-due "$if_due" --status "$status" ${session:+--session "$session"} 2>&1) || hb_rc=$?
  [ -z "$hb_out" ] || printf '%s\n' "$hb_out"
  if [ "$hb_rc" -ne 0 ]; then
    err_msg="${err_msg:+$err_msg; }step 1 (final heartbeat) failed (exit $hb_rc)"
  fi

  # Stop the detached keepalive before releasing so a concurrent keepalive tick cannot renew the baton after release.
  if ! monster_stop_keepalive "$state_dir" "$role"; then
    ka_rc=1
  fi

  # Step 2: Release the baton (--reason rotation).
  if [ -n "${MONSTER_BATON_RELEASE_CMD:-}" ]; then
    # shellcheck disable=SC2086
    rel_out=$($MONSTER_BATON_RELEASE_CMD --role "$role" --repo "$repo" --state-dir "$state_dir" \
      --reason rotation ${session:+--session "$session"} 2>&1) || rel_rc=$?
  else
    rel_out=$(node "$baton_lib" release --role "$role" --repo "$repo" --state-dir "$state_dir" \
      --reason rotation ${session:+--session "$session"} 2>&1) || rel_rc=$?
  fi
  [ -z "$rel_out" ] || printf '%s\n' "$rel_out"
  if [ "$rel_rc" -ne 0 ]; then
    err_msg="${err_msg:+$err_msg; }step 2 (baton release) failed (exit $rel_rc)"
  elif ! printf '%s' "$rel_out" | tail -n 1 | jq -e '.ok == true and .released == true' >/dev/null 2>&1; then
    rel_rc=1
    err_msg="${err_msg:+$err_msg; }step 2 (baton release) did not release a held baton: $(printf '%s' "$rel_out" | tail -n 1)"
  fi

  # Step 3: Ensure the detached keepalive is stopped.
  if ! monster_stop_keepalive "$state_dir" "$role" || [ "$ka_rc" -ne 0 ]; then
    err_msg="${err_msg:+$err_msg; }step 3 (stop keepalive) failed"
  fi

  if [ -n "$err_msg" ]; then
    printf 'ERROR: %s baton rotate failed: %s\n' "$role" "$err_msg" >&2
    return 1
  fi
  return 0
}

# monster_memory_tail_sync ROLE REPO STATE_DIR: best-effort memory delta sync on heartbeat (docs/memory-spec.md §9).
monster_memory_tail_sync() {
  local role="$1" repo="$2" state_dir="${3:-}" mem_script
  [ "${ENGSYS_MEMORY_SYNC:-}" != "0" ] || return 0
  [ "${ENGSYS_MEMORY_SYNC:-0}" = 1 ] || [ -f "${CLAUDE_PROJECT_DIR:-.}/.claude/memory.yml" ] || return 0
  mem_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../scripts/memory-sync.mjs"
  [ -f "$mem_script" ] || return 0
  # stderr is kept only for the capped-fetch warning (engsys#189): it goes to this heartbeat's stderr and to
  # <state_dir>/memory-sync-capped.warn (latest wins, removed once a run no longer warns), so the operator sees a
  # repo whose delta keeps hitting the GraphQL page cap. Everything else stays best-effort and silent.
  local errout warn nrc=0
  errout="$(node "$mem_script" --delta --repo "$repo" ${state_dir:+--state-dir "$state_dir"} ${FLEET_ID:+--role "$role" --fleet "$FLEET_ID"} 2>&1 >/dev/null)" || nrc=$?
  warn="$(printf '%s\n' "$errout" | grep 'hit the GraphQL page cap' | tail -n 1 || true)"
  if [ -n "$warn" ]; then
    printf '%s\n' "$warn" >&2
    [ -z "$state_dir" ] || [ ! -d "$state_dir" ] || printf '%s\n' "$warn" >"$state_dir/memory-sync-capped.warn" 2>/dev/null || true
  elif [ "$nrc" = 0 ] && [ -n "$state_dir" ]; then   # a failed run proves nothing: keep an earlier warning
    rm -f "$state_dir/memory-sync-capped.warn" 2>/dev/null || true
  fi
  return 0
}

