#!/usr/bin/env node
// harness-io.mjs — Tri-harness (Claude Code, GitHub Copilot CLI, Google Antigravity)
// hook stdin/stdout/stderr/exit-code normalizer and plugin root resolver.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COPILOT_EVENTS = new Set([
  'preToolUse',
  'postToolUse',
  'sessionStart',
  'sessionEnd',
  'userPromptSubmitted',
  'subagentStart',
  'subagentStop',
]);

const COPILOT_TOOLS = new Set(['bash', 'edit', 'create', 'view', 'glob', 'grep', 'task']);

const AGY_TOOLS = new Set([
  'run_command',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'view_file',
  'grep_search',
  'find_by_name',
  'invoke_subagent',
  'schedule',
]);

const EVENT_MAP = {
  preToolUse: 'PreToolUse',
  PreToolUse: 'PreToolUse',
  postToolUse: 'PostToolUse',
  PostToolUse: 'PostToolUse',
  sessionStart: 'SessionStart',
  SessionStart: 'SessionStart',
  sessionEnd: 'Stop',
  Stop: 'Stop',
  userPromptSubmitted: 'UserPromptSubmit',
  UserPromptSubmit: 'UserPromptSubmit',
  subagentStart: 'SubagentStart',
  SubagentStart: 'SubagentStart',
  subagentStop: 'SubagentStop',
  SubagentStop: 'SubagentStop',
};

function normalizeHarnessName(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'claude' || s === 'claude-code') return 'claude';
  if (s === 'copilot' || s === 'copilot-cli' || s === 'gh-copilot') return 'copilot';
  if (s === 'antigravity' || s === 'agy') return 'antigravity';
  return null;
}

/**
 * Detect active harness ('claude' | 'copilot' | 'antigravity') from environment or hook stdin payload.
 */
export function detectHarness(env = process.env, rawStdinObj = null) {
  const explicit = normalizeHarnessName(env?.ENGSYS_HARNESS || env?.FLEET_HARNESS);
  if (explicit) return explicit;

  if (rawStdinObj && typeof rawStdinObj === 'object') {
    const tName =
      rawStdinObj.tool_name ??
      rawStdinObj.toolName ??
      (rawStdinObj.toolCall && rawStdinObj.toolCall.name);
    if (
      AGY_TOOLS.has(tName) ||
      (rawStdinObj.toolCall && typeof rawStdinObj.toolCall === 'object') ||
      'conversationId' in rawStdinObj ||
      Array.isArray(rawStdinObj.workspacePaths) ||
      (rawStdinObj.tool_input && ('CommandLine' in rawStdinObj.tool_input || 'TargetFile' in rawStdinObj.tool_input))
    ) {
      return 'antigravity';
    }

    if (
      'toolArgs' in rawStdinObj ||
      'sessionId' in rawStdinObj ||
      'lastAssistantMessage' in rawStdinObj ||
      'agentId' in rawStdinObj ||
      'agentType' in rawStdinObj ||
      COPILOT_EVENTS.has(rawStdinObj.hookEventName) ||
      COPILOT_EVENTS.has(rawStdinObj.event) ||
      COPILOT_TOOLS.has(rawStdinObj.toolName)
    ) {
      return 'copilot';
    }

    if ('hook_event_name' in rawStdinObj || 'tool_name' in rawStdinObj) {
      return 'claude';
    }
  }

  if (env?.COPILOT_PLUGIN_ROOT || env?.COPILOT_HOME || env?.GITHUB_COPILOT_CLI) return 'copilot';
  if (env?.AGY_PLUGIN_ROOT || env?.ANTIGRAVITY_CLI || env?.ANTIGRAVITY_SESSION) return 'antigravity';
  return 'claude';
}

/**
 * Resolve the engsys plugin/core root across Claude Code, Copilot CLI, and Antigravity.
 */
export function resolvePluginRoot(env = process.env, importMetaUrl = null) {
  const fromEnv =
    env?.ENGSYS_PLUGIN_ROOT ||
    env?.CLAUDE_PLUGIN_ROOT ||
    env?.COPILOT_PLUGIN_ROOT ||
    env?.AGY_PLUGIN_ROOT;
  if (fromEnv) return fromEnv;
  if (importMetaUrl) return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), '..');
  return process.cwd();
}

/**
 * Map harness-native tool names to canonical engsys tool names.
 */
export function normalizeToolName(rawToolName) {
  const name = String(rawToolName ?? '').trim();
  switch (name) {
    case 'bash':
    case 'run_command':
    case 'Bash':
      return 'Bash';
    case 'Monitor':
      return 'Monitor';
    case 'create':
    case 'write_to_file':
    case 'Write':
      return 'Write';
    case 'edit':
    case 'replace_file_content':
    case 'Edit':
      return 'Edit';
    case 'multi_replace_file_content':
    case 'MultiEdit':
      return 'MultiEdit';
    case 'NotebookEdit':
      return 'NotebookEdit';
    case 'view':
    case 'view_file':
    case 'Read':
      return 'Read';
    case 'grep':
    case 'grep_search':
    case 'Grep':
      return 'Grep';
    case 'glob':
    case 'find_by_name':
    case 'Glob':
      return 'Glob';
    case 'task':
    case 'invoke_subagent':
    case 'Agent':
    case 'Task':
      return 'Agent';
    case 'schedule':
    case 'CronCreate':
      return 'CronCreate';
    default:
      return name;
  }
}

/**
 * Parse and normalize hook stdin payload from Claude Code, Copilot CLI, or Antigravity.
 */
export function parseHookInput(rawStdin, env = process.env) {
  let obj = {};
  if (rawStdin && typeof rawStdin === 'object') {
    obj = rawStdin;
  } else if (typeof rawStdin === 'string' && rawStdin.trim()) {
    try {
      obj = JSON.parse(rawStdin);
    } catch {
      obj = {};
    }
  }

  const harness = detectHarness(env, obj);
  const rawEvent = obj.hook_event_name ?? obj.hookEventName ?? obj.event ?? '';
  const event = EVENT_MAP[rawEvent] || rawEvent || null;
  const rawToolName =
    obj.tool_name ??
    obj.toolName ??
    (obj.toolCall && obj.toolCall.name) ??
    '';
  const toolName = normalizeToolName(rawToolName);

  const tcPayload =
    obj.toolCall && typeof obj.toolCall === 'object'
      ? (obj.toolCall.args ?? obj.toolCall.arguments ?? obj.toolCall.input)
      : null;

  let rawToolInput = {};
  if (typeof obj.toolArgs === 'string') {
    try {
      rawToolInput = JSON.parse(obj.toolArgs);
    } catch {
      rawToolInput = { command: obj.toolArgs };
    }
  } else if (obj.toolArgs && typeof obj.toolArgs === 'object') {
    rawToolInput = obj.toolArgs;
  } else if (typeof tcPayload === 'string') {
    try {
      rawToolInput = JSON.parse(tcPayload);
    } catch {
      rawToolInput = { command: tcPayload };
    }
  } else if (tcPayload && typeof tcPayload === 'object') {
    rawToolInput = tcPayload;
  } else if (obj.tool_input && typeof obj.tool_input === 'object') {
    rawToolInput = obj.tool_input;
  } else if (obj.toolInput && typeof obj.toolInput === 'object') {
    rawToolInput = obj.toolInput;
  } else if (obj.input && typeof obj.input === 'object') {
    rawToolInput = obj.input;
  }

  const command =
    rawToolInput.command ??
    rawToolInput.CommandLine ??
    (typeof obj.command === 'string' ? obj.command : null);

  const filePath =
    rawToolInput.file_path ??
    rawToolInput.path ??
    rawToolInput.TargetFile ??
    rawToolInput.AbsolutePath ??
    rawToolInput.notebook_path ??
    null;

  const content =
    rawToolInput.content ??
    rawToolInput.CodeContent ??
    rawToolInput.new_str ??
    rawToolInput.ReplacementContent ??
    null;

  let prompt = rawToolInput.prompt ?? rawToolInput.Prompt ?? obj.prompt ?? null;
  let agentType =
    obj.agent_type ??
    obj.agentType ??
    rawToolInput.subagent_type ??
    rawToolInput.agent_type ??
    rawToolInput.agent ??
    rawToolInput.TypeName ??
    null;

  if (Array.isArray(rawToolInput.Subagents) && rawToolInput.Subagents.length > 0) {
    const first = rawToolInput.Subagents[0];
    if (!prompt && typeof first?.Prompt === 'string') prompt = first.Prompt;
    if (!agentType && typeof first?.TypeName === 'string') agentType = first.TypeName;
  }

  const toolInput = {
    ...rawToolInput,
    ...(command !== null && command !== undefined ? { command } : {}),
    ...(filePath !== null && filePath !== undefined ? { file_path: filePath, path: filePath } : {}),
    ...(content !== null && content !== undefined ? { content } : {}),
  };

  const sessionId =
    obj.session_id ??
    obj.sessionId ??
    obj.conversationId ??
    env?.ENGSYS_SESSION ??
    null;
  const transcriptPath = obj.transcript_path ?? obj.transcriptPath ?? null;
  const workspaceRoot =
    Array.isArray(obj.workspacePaths) && typeof obj.workspacePaths[0] === 'string'
      ? obj.workspacePaths[0].replace(/^file:\/\//, '')
      : null;
  const cwd =
    (typeof rawToolInput.Cwd === 'string' && rawToolInput.Cwd) ||
    (typeof obj.cwd === 'string' && obj.cwd) ||
    workspaceRoot ||
    process.cwd();

  return {
    harness,
    event,
    toolName,
    rawToolName,
    toolInput,
    command,
    filePath,
    content,
    prompt,
    agentType,
    sessionId,
    transcriptPath,
    cwd,
    raw: obj,
  };
}

export const normalizeHookInput = parseHookInput;

/**
 * CT-01, CT-02, CT-03: PreToolUse deny output descriptor.
 */
export function emitPreToolDeny(harness, reason) {
  const h = normalizeHarnessName(harness) || 'claude';
  const msg = String(reason ?? '');
  if (h === 'antigravity') {
    return {
      stderr: msg,
      exitCode: 2,
    };
  }
  return {
    json: {
      permissionDecision: 'deny',
      permissionDecisionReason: msg,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: msg,
      },
    },
    exitCode: 0,
  };
}

/**
 * PreToolUse allow + additionalContext (and optional updatedInput for Claude Code).
 */
export function emitPreToolAllowWithContext(harness, additionalContext, updatedInput = undefined) {
  const h = normalizeHarnessName(harness) || 'claude';
  const ctx = String(additionalContext ?? '');
  if (h === 'antigravity') {
    return {
      stdout: ctx,
      exitCode: 0,
    };
  }
  return {
    json: {
      permissionDecision: 'allow',
      additionalContext: ctx,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext: ctx,
        ...(updatedInput ? { updatedInput } : {}),
      },
    },
    exitCode: 0,
  };
}

/**
 * CT-04: PostToolUse context output descriptor.
 */
export function emitPostToolContext(harness, additionalContext) {
  const h = normalizeHarnessName(harness) || 'claude';
  const ctx = String(additionalContext ?? '');
  if (h === 'antigravity') {
    return {
      stdout: ctx,
      exitCode: 0,
    };
  }
  return {
    json: {
      additionalContext: ctx,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: ctx,
      },
    },
    exitCode: 0,
  };
}

/**
 * CT-05, CT-07: SessionStart context output descriptor.
 */
export function emitSessionStartContext(harness, additionalContext, { jsonMode = false } = {}) {
  const h = normalizeHarnessName(harness) || 'claude';
  const ctx = String(additionalContext ?? '');
  if (h === 'antigravity') {
    return {
      stdout: ctx,
      exitCode: 0,
    };
  }
  if (h === 'copilot' || jsonMode) {
    return {
      json: {
        additionalContext: ctx,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: ctx,
        },
      },
      exitCode: 0,
    };
  }
  return {
    stdout: ctx,
    exitCode: 0,
  };
}

/**
 * CT-06: Stop / SubagentStop block output descriptor.
 */
export function emitStopBlock(harness, reason) {
  const h = normalizeHarnessName(harness) || 'claude';
  const msg = String(reason ?? '');
  if (h === 'antigravity') {
    return {
      stderr: msg,
      exitCode: 2,
    };
  }
  return {
    json: { decision: 'block', reason: msg },
    exitCode: 0,
  };
}

const MAX_HOOK_TELEMETRY_BYTES = 512 * 1024;

/**
 * Resolve the Hook Flight Recorder JSONL path (`~/.local/state/engsys/sessions/hook-events.jsonl`
 * or `$ENGSYS_HOOK_TELEMETRY_FILE`). Returns `null` when disabled (`ENGSYS_HOOK_TELEMETRY=0`) or
 * inside `node --test` unless explicitly opted in.
 */
export function hookTelemetryPath(env = process.env) {
  if (!env || env.ENGSYS_HOOK_TELEMETRY === '0') return null;
  if (env.ENGSYS_HOOK_TELEMETRY_FILE) return env.ENGSYS_HOOK_TELEMETRY_FILE;
  if ((env.NODE_TEST_CONTEXT || process.env.NODE_TEST_CONTEXT) && env.ENGSYS_HOOK_TELEMETRY !== '1') return null;
  const dir =
    env.ENGSYS_SESSIONS_DIR ||
    path.join(env.XDG_STATE_HOME || path.join(env.HOME || os.homedir(), '.local', 'state'), 'engsys', 'sessions');
  return path.join(dir, 'hook-events.jsonl');
}

/**
 * Append a single Hook Flight Recorder event (`hook-events.jsonl`, auto-rotated at 512 KB).
 * Fail-open: never throws or blocks a hook.
 */
export function recordHookTelemetry(entry, env = process.env) {
  try {
    const file = hookTelemetryPath(env);
    if (!file || !entry || typeof entry !== 'object') return null;
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_HOOK_TELEMETRY_BYTES) {
        fs.renameSync(file, `${file}.1`);
      }
    } catch { /* file does not exist yet */ }
    const clean = (v, n = 160) =>
      v === null || v === undefined ? null : String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, n);
    const rec = {
      ts: entry.ts || new Date().toISOString(),
      session: clean(entry.session ?? env.ENGSYS_SESSION ?? null, 80),
      fleet: clean(entry.fleet ?? env.FLEET_ID ?? null, 40),
      role: clean(entry.role ?? env.ENGSYS_SINGLETON_ROLE ?? null, 32),
      harness: clean(entry.harness ?? detectHarness(env), 24),
      hook: clean(entry.hook || path.basename(process.argv[1] || 'unknown', '.mjs'), 64),
      event: clean(entry.event || null, 40),
      decision: clean(entry.decision || 'allow', 24),
      bytes: typeof entry.bytes === 'number' ? entry.bytes : 0,
      ...(typeof entry.ms === 'number' ? { ms: Math.round(entry.ms) } : {}),
      ...(entry.detail ? { detail: clean(entry.detail, 200) } : {}),
    };
    fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    return rec;
  } catch {
    return null;
  }
}

/**
 * Write a hook output descriptor to stdout/stderr and return its exit code.
 */
export function writeHookResult(result, { stdout = process.stdout, stderr = process.stderr, hook, event, detail, env = process.env } = {}) {
  if (!result) return 0;
  let bytes = 0;
  let decision = 'allow';
  let inferredEvent = event || null;
  if (result.json !== undefined) {
    const s = JSON.stringify(result.json);
    bytes = Buffer.byteLength(s, 'utf8');
    stdout.write(s);
    const j = result.json;
    inferredEvent = inferredEvent || j?.hookSpecificOutput?.hookEventName || null;
    if (j?.permissionDecision === 'deny' || j?.hookSpecificOutput?.permissionDecision === 'deny') {
      decision = 'deny';
    } else if (j?.decision === 'block') {
      decision = 'block';
    } else if (j?.additionalContext || j?.hookSpecificOutput?.additionalContext) {
      decision = 'context';
    }
  } else if (typeof result.stdout === 'string' && result.stdout.length > 0) {
    bytes = Buffer.byteLength(result.stdout, 'utf8');
    stdout.write(result.stdout);
    decision = 'context';
  }
  if (typeof result.stderr === 'string' && result.stderr.length > 0) {
    stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
    if (result.exitCode === 2) decision = 'block';
  }
  if (hook || !env?.NODE_TEST_CONTEXT || env?.ENGSYS_HOOK_TELEMETRY_FILE || env?.ENGSYS_HOOK_TELEMETRY === '1') {
    recordHookTelemetry(
      {
        hook,
        event: inferredEvent,
        decision,
        bytes,
        detail:
          detail ||
          result.json?.permissionDecisionReason ||
          result.json?.reason ||
          (typeof result.stderr === 'string' ? result.stderr.trim() : null),
      },
      env,
    );
  }
  return typeof result.exitCode === 'number' ? result.exitCode : 0;
}

