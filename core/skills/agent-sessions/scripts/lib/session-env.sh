# shellcheck shell=bash
# session-env.sh — the harness-neutral core of launch-agent-sessions.sh (engsys#287, phase 2).
#
# Sourced by the launcher, never run. It holds what a session line is (its identity, its monster role, whether it
# is security tier), which lines a harness may run, and the trust environment every launch line carries, in one
# function, assemble_trust_env. It knows harnesses only through the capabilities the loaded adapter declares
# (lib/harness/<harness>.sh, has_capability); it never compares harness names.
#
# Globals it reads (set by the launcher): HARNESS (for messages only), HARNESS_CAPS, VERDICT_KEY_FILE,
# MEMORY_KEY_FILE, LAUNCHER_FLEET_CFG, LAUNCHER_CFG_SESSIONS, CLAUDE_CONFIG_DIR, ENGSYS_CONFIG_DIR_SESSIONS,
# FLEET_CLAUDE_CONFIG_DIR_INTERACTIVE, ENGSYS_SUPERVISED_SESSIONS.
#
# TRUST CORE RULES (each is pinned by the golden launch lines, launch-golden.test.sh):
#   The trust variables: identity ENGSYS_SESSION, ENGSYS_SESSION_RUN, ENGSYS_SESSION_ROOT, ENGSYS_SINGLETON_ROLE;
#   keys ENGSYS_SECURITY_VERDICT_KEY_FILE, ENGSYS_MEMORY_SIGNING_KEY_FILE; config ENGSYS_MEMORY_CONFIG,
#   ENGSYS_MM_CONFIG, CLAUDE_CONFIG_DIR, FLEET_CLAUDE_CONFIG_DIR, FLEET_CLAUDE_CONFIG_DIR_SCOPE,
#   ENGSYS_CONFIG_DIR_SESSIONS.
#   1. Before the env file, the line sets its identity and clears ENGSYS_MEMORY_SIGNING_KEY_FILE,
#      ENGSYS_MEMORY_CONFIG and ENGSYS_MM_CONFIG; ENGSYS_SECURITY_VERDICT_KEY_FILE is exported if the line is granted
#      it (rule 4) and cleared otherwise.
#   2. The env file is sourced (set -a), if the line has one.
#   3. After it, every trust variable is decided again, from launcher state only: the identity is set again, and
#      each other variable is exported when this line is granted it and unset otherwise. None is ever left over
#      from the env file or from the window's inherited environment (a tmux server's global environment can hold
#      anything); FLEET_CLAUDE_CONFIG_DIR_SCOPE is `supervised` under scope supervised and unset otherwise. A
#      `claude` shell function is dropped before the harness runs. The whole line is one fail-closed && chain.
#   4. A trust variable is granted only when the adapter declares the capability:
#        ENGSYS_SECURITY_VERDICT_KEY_FILE   security_lane; a security-ENV line only, never a merge line
#        ENGSYS_MEMORY_SIGNING_KEY_FILE     memory_signing; merge and maintain lines only
#        ENGSYS_MM_CONFIG                   mm_config; merge lines only
#        CLAUDE_CONFIG_DIR, ENGSYS_MEMORY_CONFIG   claude_config_dir
#      and only when the launcher was given the key / config at all.
#   5. Monster (merge, maintain), resource-broker, host-supervised and security-tier lines are refused unless the
#      adapter declares monster_roles (and security_lane for a security-tier line): check_line_policy.
#   6. No trust value is typed into the tmux window: the line goes into the launch file only (engsys#236), and
#      the launcher's own environment never carries the keys (scrubbed at its start).

# The capabilities an adapter may declare (harness_capabilities). monster_roles, security_lane, memory_signing,
# mm_config, claude_config_dir and settings_file drive decisions here and in the launcher; remote_control and
# inbox_hook are declarative today (the adapter's own translate/prelaunch, and the plugin's inbox hook).
# shellcheck disable=SC2034 # read by the launcher (load_harness_adapter)
HARNESS_KNOWN_CAPS="monster_roles security_lane memory_signing mm_config claude_config_dir settings_file remote_control inbox_hook"

# has_capability <cap> → 0 when the loaded adapter declares it.
has_capability() {
  case " ${HARNESS_CAPS:-} " in *" $1 "*) return 0 ;; esac
  return 1
}

# expand_tilde <path> → a leading ~ replaced by $HOME, by a literal prefix splice: a pattern substitution
# (${x/#\~/$HOME}) turns an `&` in HOME into the match on bash 5.2+ (patsub_replacement).
expand_tilde() {
  case "$1" in \~*) printf '%s' "$HOME${1#\~}" ;; *) printf '%s' "$1" ;; esac
}

# Model names are normalized before any policy match: lowercase, quotes dropped, a `[…]` suffix (for
# example a context-window tag) and a trailing date stamp stripped.
norm_model() {
  local m
  m="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d "\"'")"
  m="${m%%\[*}"
  m="$(printf '%s' "$m" | sed -E 's/[-@.]?(19|20)[0-9]{2}-?[0-9]{2}-?[0-9]{2}$//')"
  printf '%s' "$m"
}
# 0 when a model names Claude Opus 4.8 in any spelling (claude-opus-4-8, claude-opus-4.8, …) or the
# `security` alias.
is_security_model() {
  local m
  m="$(norm_model "$1")"
  case "$m" in claude-opus-4-8* | claude-opus-4.8* | security) return 0 ;; esac
  return 1
}
# engsys#229: the repo's merge-monster config inside the fleet config dir (the instance plugin's
# repos/<owner>/<repo>/merge-monster.yml, core/lib/mm-config.mjs), for a merge-role line's ENGSYS_MM_CONFIG. Prints the
# first readable one, or nothing. Looked up in the session's own Claude config dir, then the launcher's.
resolve_mm_config() { # resolve_mm_config <workdir> <session config dir>
  local script args=() d out
  script="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../lib" 2>/dev/null && pwd)/mm-config.mjs"
  [ -f "$script" ] && command -v node >/dev/null && command -v jq >/dev/null || return 0
  for d in "$2" "${CLAUDE_CONFIG_DIR:-}"; do [ -z "$d" ] || args+=(--config-dir "$d"); done
  [ "${#args[@]}" -gt 0 ] || args+=(--config-dir "$HOME/.claude")
  out="$(node "$script" resolve --cwd "$1" "${args[@]}" 2>/dev/null)" || return 0
  jq -r '.configs[0] // empty' <<<"$out" 2>/dev/null || true
}
# 0 when an env file is the security lane: its name, without directory and extension, normalizes to
# `security` or `nyx`.
is_security_env() {
  local b
  [ -n "$1" ] || return 1
  b="${1##*/}"; b="${b%.*}"
  b="$(printf '%s' "$b" | tr '[:upper:]' '[:lower:]' | tr -d "\"' ")"
  case "$b" in security | nyx) return 0 ;; esac
  return 1
}
# The --model value(s) in a flag string, one per line (both `--model X` and `--model=X`).
model_values() {
  local tok prev=""
  set -f
  # shellcheck disable=SC2086
  set -- $1
  set +f
  for tok in "$@"; do
    [ "$prev" = "--model" ] && printf '%s\n' "$tok"
    case "$tok" in --model=*) printf '%s\n' "${tok#--model=}" ;; esac
    prev="$tok"
  done
  return 0
}
# A security-tier roster line: a model that names Claude Opus 4.8, or the security env lane.
is_security_line() { # is_security_line <flags> <env file> → 0 when security tier
  local m
  is_security_env "$2" && return 0
  while IFS= read -r m; do
    [ -n "$m" ] && is_security_model "$m" && return 0
  done < <(model_values "$1")
  return 1
}
# The monster role a prompt runs, case-insensitively and with `_`, spaces or `-` between the words:
# merge | maintain, or empty.
prompt_role() {
  local p
  p="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr '_ ' '--')"
  case "$p" in
    *merge-monster*) echo merge ;;
    *maintenance-monster*) echo maintain ;;
  esac
  return 0
}
# 0 when a prompt runs the resource broker (the third monster), with the same tolerance as prompt_role.
prompt_is_broker() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr '_ ' '--')" in *resource-broker*) return 0 ;; esac
  return 1
}
# 0 when the host (fleet launch) classified this session as a monster or a supervised session.
is_supervised_session() {
  case " ${ENGSYS_SUPERVISED_SESSIONS:-} " in *" $1 "*) return 0 ;; esac
  return 1
}

# Rule 5. check_line_policy <name> <prompt> <role> <flags> <session env> → 0 when this harness may run the line;
# otherwise says why on stderr and returns 1. The merge and maintain batons, the resource broker, host-supervised
# sessions and security work need monster_roles (security tier also security_lane); where they may run, the
# maintenance monster and the security env lane run on Claude Opus 4.8 and nothing else.
check_line_policy() {
  local name="$1" prompt="$2" role="$3" flags="$4" session_env="$5"
  if ! has_capability monster_roles; then
    if [ -n "$role" ]; then
      echo "error: refusing to launch '$name' (role=$role) on HARNESS=$HARNESS: merge and maintenance monsters run only on HARNESS=claude" >&2
      return 1
    fi
    if prompt_is_broker "$prompt"; then
      echo "error: refusing to launch '$name' (resource broker) on HARNESS=$HARNESS: monsters run only on HARNESS=claude" >&2
      return 1
    fi
    if is_supervised_session "$name"; then
      echo "error: refusing to launch '$name' on HARNESS=$HARNESS: the host classifies it as a monster or supervised session, which runs only on HARNESS=claude" >&2
      return 1
    fi
  fi
  if ! has_capability monster_roles || ! has_capability security_lane; then
    if is_security_line "$flags" "$session_env"; then
      echo "error: refusing to launch '$name' on HARNESS=$HARNESS: security-tier sessions run only on HARNESS=claude with claude-opus-4-8" >&2
      return 1
    fi
  fi
  if [ "$role" = maintain ] || is_security_env "$session_env"; then
    local m ok=0
    while IFS= read -r m; do
      [ -n "$m" ] || continue
      if is_security_model "$m" && [ "$(norm_model "$m")" != security ]; then ok=1; else ok=0; break; fi
    done < <(model_values "$flags")
    if [ "$ok" != 1 ]; then
      echo "error: refusing to launch '$name': the maintenance monster and the security lane must run with --model claude-opus-4-8 (got: $(model_values "$flags" | tr '\n' ' '))" >&2
      return 1
    fi
  fi
  return 0
}

# session_identity <name> <run> <root> <role> → the line's identity step (rules 1 and 3). The session's own name
# and a per-launch id, for the monsters' baton (engsys#62): the holder is <fleet>:<ENGSYS_SESSION>, and a fencing
# token on disk is honored only by the launch that took it. A merge or maintenance monster also gets
# ENGSYS_SINGLETON_ROLE, which arms the plugin's singleton-write guard hook for the session and every agent it
# dispatches; any other session has it unset. ENGSYS_SESSION_ROOT is the directory the session was launched in: a
# guarded `fleet msg send` takes its --body-file only from <root>/tmp, wherever the session cd's later (engsys#108).
session_identity() {
  local identity
  identity="export ENGSYS_SESSION=$(printf %q "$1") ENGSYS_SESSION_RUN=$(printf %q "$2") ENGSYS_SESSION_ROOT=$(printf %q "$3")"
  if [ -n "$4" ]; then identity+=" ENGSYS_SINGLETON_ROLE=$4 && "; else identity+=" && unset ENGSYS_SINGLETON_ROLE && "; fi
  printf '%s' "$identity"
}

# assemble_trust_env <name> <prompt> <role> <flags> <session env> <workdir> <identity>
# → the launch line up to the harness: identity, the trust variables, cd and the env file, in the order of the
# rules above. Fails (stderr) only for a name that can't be a per-session config dir name.
assemble_trust_env() {
  local name="$1" prompt="$2" role="$3" flags="$4" session_env="$5" workdir="$6" identity="$7" cmd
  cmd="$identity"
  cmd+="unset ENGSYS_MEMORY_SIGNING_KEY_FILE && "   # F5: never inherited; set below, after the env file, for merge/maintain
  # engsys#197 (option B), narrowed by engsys#229: only a security-ENV session (security.env / nyx.env, the
  # security lane) on a security_lane harness is handed the PATH of the fleet's verdict key
  # (ENGSYS_SECURITY_VERDICT_KEY_FILE, passed by core/fleet/launch.sh as --verdict-key-file from
  # FLEET_SECURITY_VERDICT_KEY=on); every other session has it unset, whatever its model or env file (a merge-role
  # line never gets it). A merge session on Opus 4.8 reads attacker-authored PR content, so it must not be able to
  # mint a PASS; it still verifies, because mm-preflight.sh reads the key file by path. Decided here, before the env
  # file, and again after it. Defence in depth, not a boundary: the key file is readable by the same OS user
  # (core/lib/security-verdict.mjs).
  local grant_verdict=0
  if [ -n "$VERDICT_KEY_FILE" ] && has_capability security_lane && [ "$role" != merge ] && is_security_env "$session_env"; then
    grant_verdict=1
  fi
  if [ "$grant_verdict" = 1 ]; then
    cmd+="export ENGSYS_SECURITY_VERDICT_KEY_FILE=$(printf %q "$VERDICT_KEY_FILE") && "
  else
    cmd+="unset ENGSYS_SECURITY_VERDICT_KEY_FILE && "
  fi
  cmd+="unset ENGSYS_MEMORY_CONFIG && "   # engsys#262: cleared here, set again below for a line on a per-session login dir
  cmd+="unset ENGSYS_MM_CONFIG && "   # engsys#229: cleared here, set again below for a merge-role line once its config dir is known
  cmd+="cd $(printf %q "$workdir") && "
  if [ -n "$session_env" ]; then
    cmd+="set -a && . $(printf %q "$session_env") && set +a && "
    # the session's identity again (engsys#287): an env file can't rename the baton holder, swap its run id, or
    # arm or disarm the singleton guard
    cmd+="$identity"
  fi
  # engsys#287: the per-session dirs' parent from this launcher's own environment, or none; never the env file's or the
  # window's (core/lib/mm-config.mjs searches every dir under it for a session's plugins)
  if [ -n "$LAUNCHER_CFG_SESSIONS" ]; then cmd+="export ENGSYS_CONFIG_DIR_SESSIONS=$(printf %q "$LAUNCHER_CFG_SESSIONS") && "; else cmd+="unset ENGSYS_CONFIG_DIR_SESSIONS && "; fi
  if [ -n "$session_env" ]; then
    # and again after it, always (engsys#287): an env file can neither add the key path to a non-security session,
    # nor set one when no key is configured, nor drop it from a security one
    if [ "$grant_verdict" = 1 ]; then
      cmd+="export ENGSYS_SECURITY_VERDICT_KEY_FILE=$(printf %q "$VERDICT_KEY_FILE") && "
    else
      cmd+="unset ENGSYS_SECURITY_VERDICT_KEY_FILE && "
    fi
  fi
  # F5: a merge or maintain line on a memory_signing harness gets the PATH of the fleet's memory signing key
  # (memory-sync signs what it writes to refs/engsys/memory/* with it); no other line does. Decided after the env
  # file, so an env file can neither hand it to another line nor take it from a monster. Set only when a key is
  # configured (FLEET_MEMORY_SIGNING_KEY=on); otherwise unset on every line, so an env file can't supply one (engsys#287).
  if [ -n "$MEMORY_KEY_FILE" ] && has_capability memory_signing && { [ "$role" = merge ] || [ "$role" = maintain ]; }; then
    cmd+="export ENGSYS_MEMORY_SIGNING_KEY_FILE=$(printf %q "$MEMORY_KEY_FILE") && "
  else
    cmd+="unset ENGSYS_MEMORY_SIGNING_KEY_FILE && "
  fi
  # The Claude Code config dir (claude_config_dir) comes from the launcher's own environment (the fleet kit sets it
  # from FLEET_CLAUDE_CONFIG_DIR), never from the tmux server's, which may predate it, and it is decided after the
  # env file, so an accidental assignment there can't move a session to another dir. (Env files are trusted,
  # PR-reviewed shell code: a PATH wrapper, a DEBUG trap, `enable -n` or NODE_OPTIONS in one can still change what
  # runs. This guards against mistakes, not a hostile env file.) With FLEET_CLAUDE_CONFIG_DIR_INTERACTIVE set (scope
  # supervised), only the sessions it names run with it unset (~/.claude), and never one this launcher itself sees as
  # a monster, the resource broker, a supervised session or a security-tier line: an unknown session fails toward
  # the fleet dir.
  local cfg_dir=""
  has_capability claude_config_dir && cfg_dir="${CLAUDE_CONFIG_DIR:-}"
  if [ -n "$cfg_dir" ] && [ -n "${FLEET_CLAUDE_CONFIG_DIR_INTERACTIVE+x}" ]; then
    case "$FLEET_CLAUDE_CONFIG_DIR_INTERACTIVE" in
      *" $name "*)
        if [ -z "$role" ] && ! prompt_is_broker "$prompt" && ! is_supervised_session "$name" \
          && ! is_security_line "$flags" "$session_env"; then cfg_dir=""; fi ;;
    esac
  fi
  # One login per session (engsys#205): the fleet kit passes ENGSYS_CONFIG_DIR_SESSIONS (<fleet dir>.sessions) and a
  # session that gets the fleet dir runs on <that>/<its name>. The name is validated here too: nothing with a
  # slash, a leading dot or ".." can step out of that directory.
  local gate_dir="${CLAUDE_CONFIG_DIR:-}" memory_cfg=""
  if [ -n "$cfg_dir" ] && [ -n "${ENGSYS_CONFIG_DIR_SESSIONS:-}" ]; then
    case "$name" in
      '' | .* | */* | *..* | *[!A-Za-z0-9._-]*) echo "error: refusing to launch '$name': its name can't be a per-session Claude config dir name" >&2; return 1 ;;
    esac
    cfg_dir="${ENGSYS_CONFIG_DIR_SESSIONS%/}/$name"
    # engsys#262: a per-session login dir carries no memory.yml (by design: engsys#230 pins only the fleet dir's
    # copy), so the memory brief is pointed at the fleet dir's own, the launcher's CLAUDE_CONFIG_DIR.
    [ -z "${CLAUDE_CONFIG_DIR:-}" ] || memory_cfg="${CLAUDE_CONFIG_DIR%/}/memory.yml"
  fi
  [ -z "$cfg_dir" ] || gate_dir="$cfg_dir"
  # A function named claude in an env file must not stand in for the binary either. The whole line is one
  # fail-closed && chain (engsys#236 review): a `;` here restarted it, so an env file whose last command failed
  # skipped `set +a` and the key path's re-decision above, and claude still ran. zsh's `unset -f` fails for a
  # function that doesn't exist, hence the `|| true`.
  cmd+="{ unset -f claude 2>/dev/null || true; } && "
  # Under scope supervised the session knows the fleet dir and the scope, so the baton can refuse a
  # session that isn't on it (lib/lease/baton.mjs launchedSessionGate).
  if [ -n "${FLEET_CLAUDE_CONFIG_DIR_INTERACTIVE+x}" ] && [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
    cmd+="export FLEET_CLAUDE_CONFIG_DIR=$(printf %q "$gate_dir") FLEET_CLAUDE_CONFIG_DIR_SCOPE=supervised && "
  elif [ -n "$LAUNCHER_FLEET_CFG" ]; then
    # engsys#287: the fleet's own dir, from this launcher's environment (the fleet kit exports it), never the window's:
    # core/lib/mm-config.mjs searches it (and its per-session siblings) for a session's plugins
    cmd+="export FLEET_CLAUDE_CONFIG_DIR=$(printf %q "$LAUNCHER_FLEET_CFG") && unset FLEET_CLAUDE_CONFIG_DIR_SCOPE && "
  else
    cmd+="unset FLEET_CLAUDE_CONFIG_DIR FLEET_CLAUDE_CONFIG_DIR_SCOPE && "
  fi
  # engsys#262: decided after the env file, like the config dir itself, so an env file can neither move it nor set
  # one on a line that gets none (it would outrank the reviewed memory.yml).
  if [ -n "$memory_cfg" ]; then cmd+="export ENGSYS_MEMORY_CONFIG=$(printf %q "$memory_cfg") && "; else cmd+="unset ENGSYS_MEMORY_CONFIG && "; fi
  if [ -n "$cfg_dir" ]; then cmd+="export CLAUDE_CONFIG_DIR=$(printf %q "$cfg_dir") && "; else cmd+="unset CLAUDE_CONFIG_DIR && "; fi
  # engsys#229, belt and braces beside mm-preflight's own discovery: a merge-role line on an mm_config harness is told
  # where its repo's fleet merge config is; every other line, and a merge line whose config isn't found, has it
  # unset. Decided after the env file, so an env file can neither move it nor set one (engsys#287).
  local mm_cfg=""
  if [ "$role" = merge ] && has_capability mm_config; then mm_cfg="$(resolve_mm_config "$workdir" "$cfg_dir")"; fi
  if [ -n "$mm_cfg" ]; then cmd+="export ENGSYS_MM_CONFIG=$(printf %q "$mm_cfg") && "; else cmd+="unset ENGSYS_MM_CONFIG && "; fi
  printf '%s' "$cmd"
}
