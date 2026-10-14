#!/usr/bin/env bash
# monster.sh: source me. Shared helpers for the monsters' watch buses, ticks and heartbeats
# (merge-monster, maintenance-monster, resource-broker).
#
#   monster_sha256 FILE                 the file's SHA-256 (hex), portable across macOS and Linux
#   monster_cfg_scalar FILE KEY         a top-level `key: value` from a monster yml (quotes and a trailing
#                                       comment stripped); empty when absent. The monsters' configs are
#                                       flat enough for this; nested keys use the reader below.
#   monster_cfg_child FILE PARENT KEY   `parent:\n  key: value` (one level down), same rules
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
  cat >"$new"
  sha=$(monster_sha256 "$new")
  old=$(cat "$dir/last-snapshot.sha" 2>/dev/null || true)
  if [ "$sha" = "$old" ] && [ -f "$dir/last-snapshot.lines" ]; then rm -f "$new"; return 0; fi
  touch "$dir/last-snapshot.lines"
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
