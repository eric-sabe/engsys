# shellcheck shell=bash
# limit-reset.sh — read the reset time out of Claude Code's usage-limit line (sourced by fleet-supervisor.sh; unit-tested in
# fleet-supervisor.test.sh). SUPERVISOR_NOW_EPOCH, when set, replaces the clock (tests).

limit_now() { printf '%s' "${SUPERVISOR_NOW_EPOCH:-$(date +%s)}"; }

# limit_tz_fmt <zone|LOCAL> <epoch> <date format> → that instant formatted in the zone (BSD date first, GNU fallback)
limit_tz_fmt() {
  if [ "$1" = LOCAL ]; then date -r "$2" "$3" 2>/dev/null || date -d "@$2" "$3"
  else TZ="$1" date -r "$2" "$3" 2>/dev/null || TZ="$1" date -d "@$2" "$3"; fi
}
# limit_tz_epoch <zone|LOCAL> <year> <Mon> <day> <H:MM:SS AM> → the epoch of that wall-clock time in the zone. The seconds are
# always given: BSD date -j -f takes any missing field from the real clock, which made the result move with wall-clock seconds.
limit_tz_epoch() {
  if [ "$1" = LOCAL ]; then
    date -j -f '%Y %b %d %I:%M:%S %p' "$2 $3 $4 $5" +%s 2>/dev/null || date -d "$3 $4 $2 $5" +%s 2>/dev/null
  else
    TZ="$1" date -j -f '%Y %b %d %I:%M:%S %p' "$2 $3 $4 $5" +%s 2>/dev/null || TZ="$1" date -d "$3 $4 $2 $5" +%s 2>/dev/null
  fi
}
# limit_tz_day <zone|LOCAL> <epoch> <offset days> → "YYYY Mon D" of the calendar day offset from the one containing <epoch>.
# Calendar arithmetic, not +-86400 s: a day is 23 or 25 h long across a DST change. It steps from local noon, which is
# never within an hour of a day boundary.
limit_tz_day() {
  local z="$1" y mo d noon
  read -r y mo d <<<"$(limit_tz_fmt "$z" "$2" '+%Y %b %-d')"
  noon="$(limit_tz_epoch "$z" "$y" "$mo" "$d" '12:00:00 PM')" || return 1
  limit_tz_fmt "$z" $((noon + $3 * 86400)) '+%Y %b %-d'
}

# limit_reset_epoch <limit line> → the epoch of the reset time the line names, on stdout; rc 1 when it can't be read.
# The line ends `resets [<Mon> <D>[,] [at] ]<H>[:<MM>]<am|pm> (<IANA zone>)` (`resets 9pm (America/New_York)`,
# `resets Oct 20, 9:30pm (UTC)`, `reset at 5pm (UTC)`). No zone means the host's local time; no clock time or an unknown
# zone is unreadable: guessing would resume a monster hours early or never.
limit_reset_epoch() {
  local tail tz when re mon day h m ap y now ep mon_c ap_c time_s dy dm dd
  grep -qi 'reset' <<<"$1" || return 1
  # what follows the last "reset" / "resets" / "reset at": `9pm (America/New_York)`, `Oct 20, 9:30pm (UTC)`, `5am`
  tail="$(sed -E 's/.*[Rr]esets? (at )?//' <<<"$1" | head -n 1)"
  tz="$(sed -n 's/^[^(]*(\([A-Za-z0-9_+/-]*\)).*$/\1/p' <<<"$tail" | head -n 1)"
  when="$(sed -E 's/\(.*$//; s/[ .]+$//; s/^ +//' <<<"$tail" | tr 'A-Z' 'a-z')"
  [ -n "$when" ] || return 1
  if [ -z "$tz" ]; then tz=LOCAL
  else case "$tz" in UTC | GMT) ;; *) [ -e "/usr/share/zoneinfo/$tz" ] || return 1 ;; esac; fi
  re='^(([a-z]+) ([0-9]{1,2}),? (at )?)?([0-9]{1,2})(:([0-9]{2}))?[[:space:]]*(am|pm)$'
  [[ "$when" =~ $re ]] || return 1
  mon="${BASH_REMATCH[2]}" day="${BASH_REMATCH[3]}" h="${BASH_REMATCH[5]}" m="${BASH_REMATCH[7]:-00}" ap="${BASH_REMATCH[8]}"
  [ "$((10#$h))" -ge 1 ] && [ "$((10#$h))" -le 12 ] && [ "$((10#$m))" -le 59 ] || return 1
  ap_c="$(printf '%s' "$ap" | tr 'a-z' 'A-Z')"
  time_s="$((10#$h)):$m:00 $ap_c"
  now="$(limit_now)"
  if [ -n "$mon" ]; then
    mon_c="$(printf '%s' "${mon:0:1}" | tr 'a-z' 'A-Z')${mon:1:2}"
    y="$(limit_tz_fmt "$tz" "$now" +%Y)"
    ep="$(limit_tz_epoch "$tz" "$y" "$mon_c" "$((10#$day))" "$time_s")" || return 1
    # a date already well behind us belongs to next year (a December limit read in January)
    if [ "$ep" -lt $((now - 172800)) ]; then ep="$(limit_tz_epoch "$tz" "$((y + 1))" "$mon_c" "$((10#$day))" "$time_s")" || return 1; fi
  else
    # A clock time with no date: on the calendar day before, of, or after "now" in the message's zone (each day's own
    # offset, so a DST change moves nothing). It is in the future, unless it passed within the last hour (the supervisor
    # was a tick late, or the message was read just after midnight): then it is due now. One that passed longer ago is
    # tomorrow's, and one still ahead, however far, is today's.
    local yep tep
    read -r dy dm dd <<<"$(limit_tz_day "$tz" "$now" -1)"; yep="$(limit_tz_epoch "$tz" "$dy" "$dm" "$dd" "$time_s")" || return 1
    read -r dy dm dd <<<"$(limit_tz_day "$tz" "$now" 0)"; ep="$(limit_tz_epoch "$tz" "$dy" "$dm" "$dd" "$time_s")" || return 1
    read -r dy dm dd <<<"$(limit_tz_day "$tz" "$now" 1)"; tep="$(limit_tz_epoch "$tz" "$dy" "$dm" "$dd" "$time_s")" || return 1
    if [ "$now" -ge "$yep" ] && [ $((now - yep)) -le 3600 ]; then ep="$yep"
    elif [ "$ep" -gt "$now" ]; then :
    elif [ $((now - ep)) -le 3600 ]; then :
    else ep="$tep"; fi
  fi
  # a reset more than 8 days out is a misread, not a weekly limit
  [ "$ep" -le $((now + 691200)) ] || return 1
  printf '%s' "$ep"
}
