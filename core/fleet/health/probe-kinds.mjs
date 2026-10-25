#!/usr/bin/env node
// probe-kinds.mjs — the fixed set of commands Fleet Health Desk may run (engsys v2.0.1).
//
// The registry never carries a command line. A `synthetic-command` probe names a `check` kind and an
// `invoke` names an invoke `kind`; each kind here builds a literal argv array from typed, validated
// parameters, so nothing in fleet-health.yml reaches a shell or picks the executable. Every run gets
// a scrubbed environment: a small base allowlist plus only the variable groups its kind declares, so
// a probe that doesn't talk to GitHub or Azure never sees their credentials. Probes run from a neutral
// working directory (adapters.mjs), never the repo.
//
// Adding a kind is an engsys code change, reviewed like any other.
//
// Zero dependencies: node builtins only.

const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
// a single leading '/': `//host/...` is refused, never passed on (engsys#181 hardening)
const API_PATH_RE = /^\/(?!\/)[A-Za-z0-9_.\/-]{1,200}$/;
// the owner never starts with '-' (it could read as a flag); GitHub logins and orgs never do
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/;

/** Variables every kind gets (locale, paths, the user's home for CLI config files). */
export const BASE_ENV = Object.freeze([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'SystemRoot',
  'windir',
]);

/** Credential-bearing variable groups. A kind gets a group only when it lists it in `env`. */
export const ENV_GROUPS = Object.freeze({
  // gh, including the fleet App shim (GH_APP_*), which mints the installation token itself.
  github: Object.freeze({
    names: ['GITHUB_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'FLEET_ORG', 'NO_COLOR'],
    prefixes: ['GH_'],
  }),
  // az CLI config and login context.
  azure: Object.freeze({ names: [], prefixes: ['AZURE_'] }),
  // docker CLI daemon selection and client config (DOCKER_HOST, DOCKER_CONTEXT, DOCKER_CONFIG, ...).
  docker: Object.freeze({ names: [], prefixes: ['DOCKER_'] }),
});

const enumParam = (values) => ({ type: 'enum', values: Object.freeze(values) });

const TOOL_VERSION_TOOLS = ['git', 'gh', 'node', 'az', 'docker', 'claude', 'coderabbit'];
const RUN_STATUSES = [
  'queued',
  'in_progress',
  'completed',
  'requested',
  'waiting',
  'pending',
  'action_required',
  'cancelled',
  'failure',
  'neutral',
  'skipped',
  'stale',
  'startup_failure',
  'success',
  'timed_out',
];

/**
 * Read-only checks a `synthetic-command` probe (or its `auth_check`) may run.
 * `params` maps each parameter to its type; `required` lists the ones that must be present.
 */
export const PROBE_KINDS = Object.freeze({
  'gh-auth-status': {
    description: 'gh auth status [--hostname <host>]',
    params: { hostname: { type: 'hostname' } },
    env: ['github'],
    argv: (p) => ['gh', 'auth', 'status', ...(p.hostname ? ['--hostname', p.hostname] : [])],
  },
  'gh-api-get': {
    description: 'gh api --method GET <path>',
    params: { path: { type: 'api-path' } },
    required: ['path'],
    env: ['github'],
    argv: (p) => ['gh', 'api', '--method', 'GET', p.path],
  },
  'az-account-show': {
    description: 'az account show --output none',
    params: {},
    env: ['azure'],
    argv: () => ['az', 'account', 'show', '--output', 'none'],
  },
  'coderabbit-auth-status': {
    description: 'coderabbit auth status',
    params: {},
    env: [],
    argv: () => ['coderabbit', 'auth', 'status'],
  },
  'docker-info': {
    description: 'docker info --format {{.ServerVersion}}',
    params: {},
    env: ['docker'],
    argv: () => ['docker', 'info', '--format', '{{.ServerVersion}}'],
  },
  'tool-version': {
    description: `<tool> --version, tool one of ${TOOL_VERSION_TOOLS.join(', ')}`,
    params: { tool: enumParam(TOOL_VERSION_TOOLS) },
    required: ['tool'],
    env: [],
    argv: (p) => [p.tool, '--version'],
  },
});

/**
 * Commands `fleet health invoke` may run. Every invoke kind defines its own gate; a registry entry
 * can raise it (`requires_gate: true`) but never lower it.
 */
export const INVOKE_KINDS = Object.freeze({
  'gh-run-list': {
    description: 'gh run list [--repo <owner/name>] [--status <status>] [--limit <n>]',
    params: {
      repo: { type: 'repo' },
      status: enumParam(RUN_STATUSES),
      limit: { type: 'int', min: 1, max: 100 },
    },
    env: ['github'],
    gate: true,
    argv: (p) => [
      'gh',
      'run',
      'list',
      ...(p.repo ? ['--repo', p.repo] : []),
      ...(p.status ? ['--status', p.status] : []),
      ...(p.limit !== undefined ? ['--limit', String(p.limit)] : []),
    ],
  },
  'gh-api-get': {
    description: 'gh api --method GET <path>',
    params: { path: { type: 'api-path' } },
    required: ['path'],
    env: ['github'],
    gate: true,
    argv: (p) => ['gh', 'api', '--method', 'GET', p.path],
  },
});

function checkParam(name, spec, value) {
  switch (spec.type) {
    case 'hostname':
      return typeof value === 'string' && HOSTNAME_RE.test(value) ? null : `${name} must be a DNS hostname`;
    case 'api-path':
      return typeof value === 'string' && API_PATH_RE.test(value) && !value.split('/').includes('..')
        ? null
        : `${name} must be an absolute API path of letters, digits, '/', '.', '_' or '-'`;
    case 'repo':
      return typeof value === 'string' && REPO_RE.test(value) ? null : `${name} must be owner/name`;
    case 'enum':
      return spec.values.includes(value) ? null : `${name} must be one of ${spec.values.join(', ')}`;
    case 'int':
      return Number.isSafeInteger(value) && value >= spec.min && value <= spec.max
        ? null
        : `${name} must be an integer from ${spec.min} to ${spec.max}`;
    default:
      return `${name} has an unknown parameter type`;
  }
}

/**
 * Validate `params` for `kind` in `table`. Returns a list of problems (empty when valid).
 */
export function validateKindParams(table, kind, params) {
  const def = Object.prototype.hasOwnProperty.call(table, kind) ? table[kind] : null;
  if (!def) return [`unknown kind ${JSON.stringify(kind)} (allowed: ${Object.keys(table).join(', ')})`];
  const errs = [];
  if (params !== undefined && params !== null && (typeof params !== 'object' || Array.isArray(params))) {
    return ['params must be a map'];
  }
  const p = params || {};
  for (const k of Object.keys(p)) {
    if (!Object.prototype.hasOwnProperty.call(def.params, k)) {
      errs.push(`unknown param ${JSON.stringify(k)} for ${kind} (allowed: ${Object.keys(def.params).join(', ') || 'none'})`);
      continue;
    }
    const e = checkParam(k, def.params[k], p[k]);
    if (e) errs.push(e);
  }
  for (const k of def.required || []) {
    if (p[k] === undefined || p[k] === null) errs.push(`param ${JSON.stringify(k)} is required for ${kind}`);
  }
  return errs;
}

/**
 * Build `{ file, args, envGroups }` for a validated kind. Throws on an unknown kind or bad params, so
 * a registry that skipped validation still can't reach an executable.
 */
export function buildKindCommand(table, kind, params) {
  const errs = validateKindParams(table, kind, params);
  if (errs.length) throw new Error(`invalid ${kind}: ${errs.join('; ')}`);
  const def = table[kind];
  const argv = def.argv(params || {});
  return { file: argv[0], args: argv.slice(1), envGroups: def.env };
}

/**
 * Copy only the base allowlist plus the named credential groups out of `env`.
 */
export function scrubEnv(env = process.env, groups = [], { platform = process.platform } = {}) {
  // Windows env names are case-insensitive (`Path`, `SystemRoot`); match them that way there, keeping
  // each variable's own spelling in the output.
  const fold = platform === 'win32' ? (k) => k.toUpperCase() : (k) => k;
  const out = {};
  const names = new Set(BASE_ENV.map(fold));
  const prefixes = [];
  for (const g of groups) {
    const def = ENV_GROUPS[g];
    if (!def) continue;
    for (const n of def.names) names.add(fold(n));
    prefixes.push(...def.prefixes.map(fold));
  }
  for (const [k, v] of Object.entries(env || {})) {
    if (typeof v !== 'string') continue;
    const key = fold(k);
    if (names.has(key) || prefixes.some((p) => key.startsWith(p))) out[k] = v;
  }
  return out;
}
