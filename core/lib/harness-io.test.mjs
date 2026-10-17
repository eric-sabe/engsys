// harness-io.test.mjs — Unit tests for core/lib/harness-io.mjs (CT-01..CT-08, NA-1, NA-2, NA-5, #149).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  detectHarness,
  emitPostToolContext,
  emitPreToolAllowWithContext,
  emitPreToolDeny,
  emitSessionStartContext,
  emitStopBlock,
  normalizeHookInput,
  normalizeToolName,
  parseHookInput,
  resolvePluginRoot,
  writeHookResult,
} from './harness-io.mjs';

describe('core/lib/harness-io.mjs', () => {
  test('CT-01: normalizeHookInput normalizes Claude, Copilot (camelCase & PascalCase), and Antigravity PreToolUse payloads', () => {
    const claude = normalizeHookInput(
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'gh pr merge 42' },
        session_id: 'sess-claude',
      }),
      {},
    );
    assert.equal(claude.harness, 'claude');
    assert.equal(claude.event, 'PreToolUse');
    assert.equal(claude.toolName, 'Bash');
    assert.equal(claude.toolInput.command, 'gh pr merge 42');
    assert.equal(claude.sessionId, 'sess-claude');

    const copilotCamel = normalizeHookInput(
      JSON.stringify({
        hookEventName: 'preToolUse',
        toolName: 'bash',
        toolArgs: JSON.stringify({ command: 'gh pr merge 42' }),
        sessionId: 'sess-copilot-1',
      }),
      {},
    );
    assert.equal(copilotCamel.harness, 'copilot');
    assert.equal(copilotCamel.event, 'PreToolUse');
    assert.equal(copilotCamel.toolName, 'Bash');
    assert.equal(copilotCamel.toolInput.command, 'gh pr merge 42');
    assert.equal(copilotCamel.sessionId, 'sess-copilot-1');

    const copilotPascal = normalizeHookInput(
      JSON.stringify({
        hookEventName: 'PreToolUse',
        toolName: 'Edit',
        toolArgs: { path: '/repo/src/index.ts', new_str: 'x' },
        sessionId: 'sess-copilot-2',
      }),
      {},
    );
    assert.equal(copilotPascal.harness, 'copilot');
    assert.equal(copilotPascal.toolName, 'Edit');
    assert.equal(copilotPascal.toolInput.file_path, '/repo/src/index.ts');
    assert.equal(copilotPascal.sessionId, 'sess-copilot-2');

    const agy = normalizeHookInput(
      JSON.stringify({
        toolCall: {
          name: 'run_command',
          arguments: { CommandLine: 'git push origin main' },
        },
        session_id: 'sess-agy',
      }),
      {},
    );
    assert.equal(agy.harness, 'antigravity');
    assert.equal(agy.toolName, 'Bash');
    assert.equal(agy.toolInput.command, 'git push origin main');
    assert.equal(agy.sessionId, 'sess-agy');

    const agyWrite = parseHookInput(
      JSON.stringify({
        tool_name: 'write_to_file',
        tool_input: { TargetFile: '/repo/.gemini/settings.json', CodeContent: '{}' },
      }),
      {},
    );
    assert.equal(agyWrite.harness, 'antigravity');
    assert.equal(agyWrite.toolName, 'Write');
    assert.equal(agyWrite.toolInput.file_path, '/repo/.gemini/settings.json');
    assert.equal(agyWrite.content, '{}');

    const agyProto = parseHookInput(
      JSON.stringify({
        conversationId: 'conv-agy-99',
        workspacePaths: ['file:///repo/agy-ws'],
        agentId: 'sub-1',
        harness: 'copilot',
        toolCall: {
          name: 'run_command',
          args: { CommandLine: 'git push --force origin main' },
        },
      }),
      {},
    );
    assert.equal(agyProto.harness, 'antigravity');
    assert.equal(agyProto.toolName, 'Bash');
    assert.equal(agyProto.command, 'git push --force origin main');
    assert.equal(agyProto.toolInput.command, 'git push --force origin main');
    assert.equal(agyProto.sessionId, 'conv-agy-99');
    assert.equal(agyProto.cwd, '/repo/agy-ws');
  });

  test('normalizeToolName maps all three harnesses to canonical engsys tool names', () => {
    assert.equal(normalizeToolName('bash'), 'Bash');
    assert.equal(normalizeToolName('run_command'), 'Bash');
    assert.equal(normalizeToolName('create'), 'Write');
    assert.equal(normalizeToolName('write_to_file'), 'Write');
    assert.equal(normalizeToolName('edit'), 'Edit');
    assert.equal(normalizeToolName('replace_file_content'), 'Edit');
    assert.equal(normalizeToolName('multi_replace_file_content'), 'MultiEdit');
    assert.equal(normalizeToolName('view'), 'Read');
    assert.equal(normalizeToolName('view_file'), 'Read');
    assert.equal(normalizeToolName('grep'), 'Grep');
    assert.equal(normalizeToolName('grep_search'), 'Grep');
    assert.equal(normalizeToolName('glob'), 'Glob');
    assert.equal(normalizeToolName('find_by_name'), 'Glob');
    assert.equal(normalizeToolName('task'), 'Agent');
    assert.equal(normalizeToolName('invoke_subagent'), 'Agent');
    assert.equal(normalizeToolName('schedule'), 'CronCreate');
  });

  test('detectHarness and resolvePluginRoot honor env overrides and fallback order', () => {
    assert.equal(detectHarness({ ENGSYS_HARNESS: 'copilot' }), 'copilot');
    assert.equal(detectHarness({ FLEET_HARNESS: 'agy' }), 'antigravity');
    assert.equal(detectHarness({ COPILOT_PLUGIN_ROOT: '/p/copilot' }), 'copilot');
    assert.equal(detectHarness({ AGY_PLUGIN_ROOT: '/p/agy' }), 'antigravity');
    assert.equal(detectHarness({}), 'claude');

    assert.equal(resolvePluginRoot({ COPILOT_PLUGIN_ROOT: '/p/copilot' }), '/p/copilot');
    assert.equal(resolvePluginRoot({ AGY_PLUGIN_ROOT: '/p/agy' }), '/p/agy');
  });

  test('resolvePluginRoot under Claude Code takes only CLAUDE_PLUGIN_ROOT or the module location', () => {
    const meta = new URL('./sub/hook.mjs', 'file:///opt/plugin/core/').href;
    // another harness's root, or the engsys override, never moves a Claude hook's root
    assert.equal(resolvePluginRoot({ ENGSYS_PLUGIN_ROOT: '/p/engsys', CLAUDE_PLUGIN_ROOT: '/p/claude' }), '/p/claude');
    assert.equal(resolvePluginRoot({ COPILOT_PLUGIN_ROOT: '/p/copilot', CLAUDE_PLUGIN_ROOT: '/p/claude' }), '/p/claude');
    assert.equal(resolvePluginRoot({ AGY_PLUGIN_ROOT: '/p/agy', ENGSYS_PLUGIN_ROOT: '/p/e', CLAUDE_PLUGIN_ROOT: '/p/claude' }), '/p/claude');
    assert.equal(resolvePluginRoot({ ENGSYS_PLUGIN_ROOT: '/p/engsys' }, meta, 'claude'), '/opt/plugin/core');
    assert.equal(resolvePluginRoot({ ENGSYS_HARNESS: 'claude', COPILOT_PLUGIN_ROOT: '/p/copilot' }, meta), '/opt/plugin/core');
    // a harness-naming env var never moves a Claude hook's root while CLAUDE_PLUGIN_ROOT is set
    for (const k of ['ENGSYS_HARNESS', 'FLEET_ACTIVE_HARNESS', 'FLEET_HARNESS', 'HARNESS']) {
      assert.equal(resolvePluginRoot({ [k]: 'copilot', CLAUDE_PLUGIN_ROOT: '/p/claude', ENGSYS_PLUGIN_ROOT: '/p/e', COPILOT_PLUGIN_ROOT: '/p/c' }, meta), '/p/claude', k);
    }
    // positive control: without CLAUDE_PLUGIN_ROOT the env selector still picks the harness
    assert.equal(resolvePluginRoot({ ENGSYS_HARNESS: 'copilot', COPILOT_PLUGIN_ROOT: '/p/c' }, meta), '/p/c');
    // positive controls: each override counts under its own harness
    assert.equal(resolvePluginRoot({ ENGSYS_PLUGIN_ROOT: '/p/engsys', CLAUDE_PLUGIN_ROOT: '/p/claude' }, null, 'copilot'), '/p/engsys');
    assert.equal(resolvePluginRoot({ COPILOT_PLUGIN_ROOT: '/p/copilot', ENGSYS_PLUGIN_ROOT: '/p/engsys' }, null, 'copilot'), '/p/copilot');
    assert.equal(resolvePluginRoot({ AGY_PLUGIN_ROOT: '/p/agy' }, null, 'antigravity'), '/p/agy');
    assert.equal(resolvePluginRoot({ CLAUDE_PLUGIN_ROOT: '/p/claude' }, meta, 'claude'), '/p/claude');
  });

  test('parseHookInput never takes cwd from model-controlled tool_input', () => {
    const r = parseHookInput({ hook_event_name: 'PreToolUse', tool_name: 'run_command', cwd: '/work/repo', tool_input: { CommandLine: 'ls', Cwd: '/elsewhere' } }, {});
    assert.equal(r.cwd, '/work/repo');
    assert.equal(r.toolInput.Cwd, '/elsewhere', 'still readable as tool input');
    const noCwd = parseHookInput({ toolCall: { name: 'run_command', args: { CommandLine: 'ls', Cwd: '/elsewhere' } }, workspacePaths: ['file:///ws'] }, {});
    assert.equal(noCwd.cwd, '/ws', 'the harness workspace, not the tool argument');
    // positive control: the harness's own cwd field is used
    assert.equal(parseHookInput({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: '/w2', tool_input: { command: 'ls' } }, {}).cwd, '/w2');
  });

  test('CT-02, CT-04, CT-06, CT-07: emitPreToolDeny, emitPostToolContext, emitSessionStartContext, emitStopBlock, writeHookResult', () => {
    const denyCopilot = emitPreToolDeny('copilot', 'fenced only');
    assert.equal(denyCopilot.exitCode, 0);
    assert.equal(denyCopilot.json.permissionDecision, 'deny');
    assert.equal(denyCopilot.json.hookSpecificOutput.permissionDecision, 'deny');

    const denyAgy = emitPreToolDeny('antigravity', 'fenced only');
    assert.equal(denyAgy.exitCode, 2);
    assert.equal(denyAgy.stderr, 'fenced only');

    const allowCtx = emitPreToolAllowWithContext('claude', 'lesson A', { prompt: 'x' });
    assert.equal(allowCtx.json.permissionDecision, 'allow');
    assert.equal(allowCtx.json.hookSpecificOutput.additionalContext, 'lesson A');
    assert.deepEqual(allowCtx.json.hookSpecificOutput.updatedInput, { prompt: 'x' });

    const postCtx = emitPostToolContext('copilot', 'inbox msg');
    assert.equal(postCtx.json.additionalContext, 'inbox msg');
    assert.equal(postCtx.json.hookSpecificOutput.additionalContext, 'inbox msg');

    const sessCtx = emitSessionStartContext('claude', 'hello', { jsonMode: true });
    assert.equal(sessCtx.json.additionalContext, 'hello');
    assert.equal(sessCtx.json.hookSpecificOutput.additionalContext, 'hello');

    const stopCopilot = emitStopBlock('copilot', 'incomplete work');
    assert.equal(stopCopilot.exitCode, 0);
    assert.deepEqual(stopCopilot.json, { decision: 'block', reason: 'incomplete work' });

    let outStr = '';
    let errStr = '';
    const code = writeHookResult(denyAgy, {
      stdout: { write: (s) => { outStr += s; } },
      stderr: { write: (s) => { errStr += s; } },
    });
    assert.equal(code, 2);
    assert.equal(outStr, '');
    assert.equal(errStr, 'fenced only\n');
  });
});
