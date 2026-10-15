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
#   monster_pulse_max PULSE HB_MINUTES  the keepalive's --pulse-max: PULSE when set (a bare number means
#                                       minutes; 45m, 1350s and ms values pass through), else 2.25 x
#                                       HB_MINUTES, else 20m
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
#   monster_transcript [PATH]           PATH when given, else the transcript recorded for ENGSYS_SESSION; empty
#                                       when unknown or not a regular file
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
  local pulse="$1" hb="$2"
  case "$pulse" in
    '') ;;
    *[!0-9]*) case "$pulse" in *[0-9]m | *[0-9]s | *[0-9]ms) printf '%s\n' "$pulse"; return 0 ;; esac ;;
    *) printf '%sm\n' "$pulse"; return 0 ;;
  esac
  case "$hb" in '' | 0 | *[!0-9]*) printf '20m\n' ;; *) printf '%ss\n' "$((hb * 135))" ;; esac # 2.25 x hb minutes
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
    t=$(jq -r '.transcript_path // empty' "$f" 2>/dev/null || true)
  fi
  case "$t" in /*) ;; *) return 0 ;; esac
  [ -f "$t" ] && [ ! -L "$t" ] && printf '%s\n' "$t"
  return 0
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
