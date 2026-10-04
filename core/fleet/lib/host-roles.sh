# shellcheck shell=bash
# host-roles.sh — which roster sessions run on THIS host (sourced by fleet-env.sh; bash 3.2-safe).
#
# A session is "not on this host" when any of these holds (the first that applies is the reason shown):
#   1. registry: FLEET_ID is set, the federation file exists, and the session runs a singleton monster
#      (merge or maintain) whose home for its repo is another fleet. Nothing in fleet.local.conf
#      overrides this; move `home` by PR instead. A registry that can't be read (invalid, FLEET_ID not
#      declared, node missing) excludes every merge and maintain session: when this host can't tell
#      who holds a baton, it starts no singleton.
#   2. ROSTER_EXCLUDE (fleet.local.conf) matches the session.
#   3. ROLES (fleet.local.conf) is set and matches nothing about the session.
# ROLES / ROSTER_EXCLUDE entries (comma or space separated) match a session by its name (acme-build),
# its name without the namespace (build), or its kind: merge, maintain, broker (the roster prompt runs
# that monster), monster (any of those, or any session in fleet/supervisor.conf.tmpl), interactive
# (everything else). Neither set and no registry: every session runs here, as before.
#
# Call fleet_host_init once per process, then the readers below.

FLEET_HOST_READY="" FLEET_HOST_TABLE="" FLEET_HOST_WARNINGS=""

fleet_host_warn() { FLEET_HOST_WARNINGS="${FLEET_HOST_WARNINGS}$*"$'\n'; }

fleet_host_render() { # fleet_host_render <value> → rendered when it holds __NAME__ tokens, else as-is
  case "$1" in *__*__*) (fleet_render_text "$1" supervisor.conf.tmpl 2>/dev/null) || printf '%s\n' "$1" ;; *) printf '%s\n' "$1" ;; esac
}

fleet_host_kind() { # fleet_host_kind <prompt> <in-ledger 0|1> → merge | maintain | broker | monster | interactive
  case "$1" in
    *merge-monster*) echo merge ;;
    *maintenance-monster*) echo maintain ;;
    *resource-broker*) echo broker ;;
    *) if [ "$2" = 1 ]; then echo monster; else echo interactive; fi ;;
  esac
}

fleet_host_matches() { # fleet_host_matches <entry> <name> <kind> <namespace>
  local e="$1" n="$2" k="$3" ns="$4"
  [ "$e" = "$n" ] || { [ -n "$ns" ] && [ "$ns-$e" = "$n" ]; } || [ "$e" = "$k" ] && return 0
  [ "$e" = monster ] && case "$k" in merge | maintain | broker | monster) return 0 ;; esac
  return 1
}

fleet_host_list() { printf '%s\n' "$1" | tr ',' ' ' | tr -s ' ' '\n' | sed '/^$/d'; } # entries, one per line

fleet_host_init() {
  [ -z "$FLEET_HOST_READY" ] || return 0
  FLEET_HOST_READY=1 FLEET_HOST_TABLE="" FLEET_HOST_WARNINGS=""
  [ -f "$FLEET_REPO/fleet/roster.tmpl" ] || return 0
  local ns sup="$FLEET_REPO/fleet/supervisor.conf.tmpl" sup_repo="" ledger reg=off reg_why="" e
  local name prompt in_ledger kind reason repo home rc out used=""
  ns="$(fleet_roster_header NAMESPACE)"
  ledger="$(fleet_ledger_sessions)"
  if [ -f "$sup" ]; then sup_repo="$(sed -n 's/^REPO=//p' "$sup" | head -1)"; sup_repo="$(fleet_host_render "$sup_repo")"; fi

  if [ -n "$FLEET_ID" ] && [ -f "$FEDERATION_FILE" ]; then
    if ! command -v node >/dev/null 2>&1; then
      reg=broken reg_why="node not found, so $FEDERATION_FILE can't be read"
    elif ! out="$(node "$FLEET_KIT_DIR/lib/federation.mjs" validate "$FEDERATION_FILE" 2>&1)"; then
      reg=broken reg_why="$(printf '%s' "$out" | head -1)"
    else
      reg=ok
    fi
    [ "$reg" = ok ] || fleet_host_warn "registry unreadable ($reg_why): every merge and maintain session is excluded on this host until it is fixed (fleet federation validate)"
  fi

  while IFS='|' read -r name _ prompt _; do
    [ -n "$name" ] || continue
    in_ledger=0; grep -Fxq "$name" <<<"$ledger" && in_ledger=1
    kind="$(fleet_host_kind "$prompt" "$in_ledger")"
    reason=""
    # 1. the registry
    if [ "$reg" != off ]; then
      case "$kind" in
        merge | maintain)
          if [ "$reg" = broken ]; then
            reason="registry unreadable; no singleton monster starts here"
          else
            repo=""
            [ ! -f "$sup" ] || repo="$(grep -E "^$name\|[0-9]+\|[0-9]+\|" "$sup" | head -1 | cut -d'|' -f4 || true)"
            repo="$(fleet_host_render "${repo:-${sup_repo:-$PIN_REPO}}")"
            rc=0; home="$(node "$FLEET_KIT_DIR/lib/federation.mjs" home "$repo" "$kind" --file "$FEDERATION_FILE" 2>/dev/null)" || rc=$?
            if [ "$rc" = 0 ] && [ "$home" != "$FLEET_ID" ]; then
              reason="$kind home for $repo is fleet $home"
            elif [ "$rc" != 0 ]; then
              fleet_host_warn "$name runs the $kind monster, but the registry declares no $kind role for $repo: not auto-excluded (declare it in the registry, or list $name in ROSTER_EXCLUDE)"
            fi
          fi ;;
        monster)
          fleet_host_warn "$name is supervised but its roster prompt names no known monster, so the registry can't place it: not auto-excluded (list it in ROSTER_EXCLUDE if this host must not run it)" ;;
      esac
    fi
    # 2. ROSTER_EXCLUDE
    if [ -z "$reason" ] && [ -n "${ROSTER_EXCLUDE:-}" ]; then
      while IFS= read -r e; do
        if fleet_host_matches "$e" "$name" "$kind" "$ns"; then reason="ROSTER_EXCLUDE lists $e"; break; fi
      done < <(fleet_host_list "$ROSTER_EXCLUDE")
    fi
    # 3. ROLES
    if [ -z "$reason" ] && [ -n "${ROLES:-}" ]; then
      reason="not in ROLES"
      while IFS= read -r e; do
        if fleet_host_matches "$e" "$name" "$kind" "$ns"; then reason=""; break; fi
      done < <(fleet_host_list "$ROLES")
    fi
    FLEET_HOST_TABLE="${FLEET_HOST_TABLE}${name}|${kind}|${reason}"$'\n'
  done < <(grep -E '^[a-z0-9-]+\|' "$FLEET_REPO/fleet/roster.tmpl")

  # an entry that matches no session is almost always a typo
  for e in $(fleet_host_list "${ROLES:-} ${ROSTER_EXCLUDE:-}"); do
    used=0
    while IFS='|' read -r name kind _; do
      [ -n "$name" ] || continue
      if fleet_host_matches "$e" "$name" "$kind" "$ns"; then used=1; break; fi
    done <<<"$FLEET_HOST_TABLE"
    [ "$used" = 1 ] || fleet_host_warn "ROLES/ROSTER_EXCLUDE entry '$e' matches no roster session"
  done
  return 0
}

fleet_host_excluded() { # fleet_host_excluded <name> → 0 + prints the reason when the session doesn't run here
  local name kind reason
  while IFS='|' read -r name kind reason; do
    if [ "$name" = "$1" ] && [ -n "$reason" ]; then printf '%s\n' "$reason"; return 0; fi
  done <<<"$FLEET_HOST_TABLE"
  return 1
}
fleet_host_sessions() { # roster sessions that run on this host
  printf '%s' "$FLEET_HOST_TABLE" | awk -F'|' '$1 != "" && $3 == "" { print $1 }'
}
fleet_host_supervised() { # supervised (ledger-bearing) sessions that run on this host
  local n
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    fleet_host_excluded "$n" >/dev/null || echo "$n"
  done < <(fleet_ledger_sessions)
}
fleet_host_warnings() { printf '%s' "$FLEET_HOST_WARNINGS" | sed '/^$/d; s/^/WARNING /'; }
