#!/usr/bin/env node
// engsys-context.mjs — SessionStart hook for the engsys core PLUGIN (plugin-mode install).
//
// In copy mode the installer renders core/templates/CLAUDE.md.tmpl into the project's
// CLAUDE.md. In plugin mode the project keeps its own CLAUDE.md (its facts + overrides),
// so this hook injects the same generic conventions at session start instead — rendered
// in "plugin view": project-specific tokens point at the project's CLAUDE.md, copy-mode-only
// sections are dropped, commands/agents are named with their plugin namespace, and the
// <engsys-root> path convention is defined. Fail-open: any error -> no output, exit 0.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const root = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tmpl = fs.readFileSync(path.join(root, 'templates', 'CLAUDE.md.tmpl'), 'utf8');
  const hasFleetPrime = fs.existsSync(path.join(root, 'commands', 'fleet-prime.md'));

  let t = tmpl;
  // Title + description -> plugin preamble (the project's CLAUDE.md owns its own title/facts).
  t = t.replace(
    /^# \{\{PROJECT_NAME\}\}[^\n]*\n\n\{\{PROJECT_DESCRIPTION\}\}\n\n[^\n]*\n/,
    [
      '## engsys conventions (injected by the engsys plugin)',
      '',
      `\`<engsys-root>\` = ${root} — paths written \`<engsys-root>/…\` in engsys skills, commands and workflows resolve here; \`<skill-dir>\` is the invoking skill's own directory.`,
      'The project\'s own CLAUDE.md holds its facts and overrides; where it conflicts with these conventions, the project\'s CLAUDE.md wins.',
      '',
    ].join('\n'),
  );
  t = t.replace(/\n`<engsys-root>` = `\.claude\/`[^\n]*\n/, '\n'); // copy-mode definition; plugin preamble defines it
  t = t.replace('{{MODEL_STRATEGY}}', "_This project's tier assignments live in its CLAUDE.md._");
  t = t.replace(/## Worker providers\n\n\{\{PROVIDER_ROUTING\}\}\n\n?/, ''); // worker layer: copy-mode only
  t = t.replace(/\{\{STACK_FRAGMENTS\}\}\n\n?/, ''); // each enabled stack-pack plugin injects its own fragment
  t = t.replace(
    /\{\{MCP_SERVERS\}\}\n\n[^\n]*\n/,
    "MCP servers come from the enabled engsys stack-pack plugins and the project's `.mcp.json`.\n",
  );
  t = t.replace(
    /Imported into \[`\.claude\/commands\/`\]\(\.claude\/commands\/\):\n\n\{\{COMMANDS_LIST\}\}/,
    'engsys commands and skills are plugin skills — invoke them namespaced as `/engsys:<name>` (e.g. `/engsys:implement-issue`, `/engsys:merge-monster`); engsys agents are `engsys:<agent>` (e.g. `engsys:isabelle`). A project command, skill, or agent with the same bare name is that project\'s override.',
  );
  t = t.replace(
    /## Hooks\n\n[^\n]*\n/,
    [
      '## Hooks',
      '',
      `The engsys plugin wires two \`SessionStart\` re-ground hooks — matcher \`compact\` (after a context compaction) and \`clear|resume\` (after \`/clear\`, \`--continue\` or \`--resume\`, which drop any loaded skill) — and re-injects these conventions on every session start. Each enabled stack-pack plugin injects its own guidance and may add post-edit reminders; the project's \`.claude/settings.json\` may wire more (e.g. its own post-edit reminders).${hasFleetPrime ? ' Run `/engsys:fleet-prime` to re-ground on demand.' : ''}`,
      '',
    ].join('\n'),
  );
  t = t.replace(
    '{{LESSONS_NOTE}}',
    "Durable lessons live in the project's `docs/agent-lessons/` (plugin mode doesn't seed the engsys lessons-library).",
  );
  t = t.replace(/\n<!--\s*\n\s*ENGSYS:PROJECT-FACTS region\.[\s\S]*$/, '\n'); // the project's CLAUDE.md is its facts

  if (/\{\{[A-Z_]+\}\}/.test(t)) throw new Error('unrendered template token'); // never inject a half-rendered template
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: t.trim() + '\n' } }),
  );
} catch {
  process.exit(0);
}
