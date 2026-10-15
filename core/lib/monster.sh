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
#   monster_rotation_status STATE_DIR STATUS THRESHOLD [TRANSCRIPT]
#                                       sets MONSTER_STATUS, the heartbeat status to write: over THRESHOLD
#                                       tokens (0 = never) with nothing active, `rotation requested — ctx <N>k`,
#                                       sticky for that transcript (.watch/rotation-requested) so every later
#                                       heartbeat of the same session repeats it; else STATUS unchanged. A
#                                       status that already ends the session (rotation, session end, handover)
#                                       is never replaced. MONSTER_ROTATION=1 when it is the rotation status;
#                                       MONSTER_CTX = the tokens read (empty when unknown).

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

# _monster_lock DIR NAME / _monster_unlock DIR NAME: the scan.lock pattern (mm-agent-watch.sh): mkdir is the
# mutex, a lock older than 30 s is a crashed holder and is stolen by an atomic mv. Gives up after ~5 s (exit 1):
# the caller skips this pass and the next poll catches up.
_monster_lock() {
  local l="$1/.watch/$2.lock" tries=0 lm
  until mkdir "$l" 2>/dev/null; do
    tries=$((tries + 1)); [ "$tries" -le 25 ] || return 1
    lm=$(stat -c %Y "$l" 2>/dev/null || stat -f %m "$l" 2>/dev/null || echo 0)
    case "$lm" in '' | *[!0-9]*) lm=0 ;; esac
    if [ "$lm" -gt 0 ] && [ $(($(date +%s) - lm)) -gt 30 ]; then
      mv "$l" "$l.stale.$$" 2>/dev/null && rmdir "$l.stale.$$" 2>/dev/null
      continue
    fi
    sleep 0.2
  done
}
_monster_unlock() { rmdir "$1/.watch/$2.lock" 2>/dev/null || true; }

monster_handback_events() {
  local s="${ENGSYS_SESSION:-}" f size off chunk
  case "$s" in '' | *[!A-Za-z0-9._-]*) return 0 ;; esac
  f="$(monster_sessions_dir)/${FLEET_ID:+$FLEET_ID.}$s.handbacks.jsonl"
  [ -f "$f" ] || return 0
  mkdir -p "$1/.watch" 2>/dev/null || return 0
  # The bus and the tick both relay: one reader at a time, so no line is emitted twice (engsys#137 review).
  _monster_lock "$1" handbacks || return 0
  size=$(wc -c <"$f" | tr -d ' ')
  off=$(cat "$1/.watch/handbacks.off" 2>/dev/null || true)
  case "$off" in '' | *[!0-9]*) off=0 ;; esac
  [ "$off" -le "$size" ] || off=0 # the log was replaced
  if [ "$size" -gt "$off" ]; then
    chunk=$(mktemp "$1/.watch/handbacks.chunk.XXXXXX") || { _monster_unlock "$1" handbacks; return 0; }
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
  printf '%s\n' "$size" >"$1/.watch/handbacks.off"
  _monster_unlock "$1" handbacks
}

# monster_handback_prune: drop the hand-back log's lines from other launches (run != ENGSYS_SESSION_RUN), so
# the log never grows across relaunches. The buses run it once at start, before their first read; the
# offset file is reset with it, since the kept lines are renumbered.
monster_handback_prune() {
  local s="${ENGSYS_SESSION:-}" run="${ENGSYS_SESSION_RUN:-}" f tmp off
  case "$s" in '' | *[!A-Za-z0-9._-]*) return 0 ;; esac
  [ -n "$run" ] || return 0
  f="$(monster_sessions_dir)/${FLEET_ID:+$FLEET_ID.}$s.handbacks.jsonl"
  [ -f "$f" ] || return 0
  mkdir -p "$1/.watch" 2>/dev/null || return 0
  _monster_lock "$1" handbacks || return 0
  tmp=$(mktemp "$f.XXXXXX") || { _monster_unlock "$1" handbacks; return 0; }
  off=$(cat "$1/.watch/handbacks.off" 2>/dev/null || true)
  case "$off" in '' | *[!0-9]*) off=0 ;; esac
  # Keep this launch's complete lines. The new offset is the size of the kept lines that lay before the old
  # offset (already relayed), so nothing this launch logged is lost or relayed twice.
  jq -R -c --arg run "$run" 'fromjson? | select(.run == $run)' "$f" >"$tmp" 2>/dev/null
  if [ "$(wc -c <"$tmp" | tr -d ' ')" -lt "$(wc -c <"$f" | tr -d ' ')" ]; then
    head -c "$off" "$f" | jq -R -c --arg run "$run" 'fromjson? | select(.run == $run)' 2>/dev/null | wc -c | tr -d ' ' >"$1/.watch/handbacks.off"
    chmod 600 "$tmp" 2>/dev/null
    mv "$tmp" "$f"
  else
    rm -f "$tmp"
  fi
  _monster_unlock "$1" handbacks
}

monster_context_tokens() {
  [ -f "$1" ] || return 0
  tail -c 65536 "$1" 2>/dev/null | jq -R -r '
    fromjson? | select(.type == "assistant" and (.isSidechain | not) and (.message.usage | type) == "object")
    | .message.usage | (.input_tokens // 0) + (.cache_creation_input_tokens // 0) + (.cache_read_input_tokens // 0)' \
    2>/dev/null | tail -n 1
}

monster_rotation_status() {
  local dir="$1" threshold="$3" t sticky tokens
  MONSTER_STATUS="$2" MONSTER_ROTATION=0 MONSTER_CTX=""
  case "$MONSTER_STATUS" in *[Rr]otation\ requested* | *[Ss]ession\ end* | *[Hh]andover*) return 0 ;; esac
  case "$threshold" in '' | *[!0-9]*) threshold=300000 ;; esac
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
