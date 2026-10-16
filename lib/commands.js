'use strict';

const {
  fs, path, ensureDir, readText, writeText, exists, sha256,
  copyDir, loadConfig,
} = require('./util');
const { buildManifest } = require('./manifest');
const render = require('./render');

const ENGSYS_VERSION = require('../package.json').version;
const PF_MARKER = 'ENGSYS:PROJECT-FACTS:START';
const BACKUP_DIR = '.claude/.engsys-backup';

function resolveConfigPath(into, explicit) {
  if (explicit) return explicit;
  for (const name of ['engsys.config.yaml', 'engsys.config.yml', 'engsys.config.json']) {
    const p = path.join(into, name);
    if (exists(p)) return p;
  }
  throw new Error(`No engsys.config.{yaml,yml,json} found in ${into} (pass --config to override).`);
}

// A stack-specific lesson carries a `**Stack:** <name> …` line (core/lessons-library/README.md). Seed it only
// when the project installs a matching pack; lessons without the line apply everywhere.
const LESSON_STACK_PACKS = {
  pnpm: ['lang/typescript'],
  react: ['platform/web'],
  web: ['platform/web'],
  prisma: ['db/prisma'],
};
function lessonAppliesToPacks(text, packs) {
  const m = /^\*\*Stack:\*\*\s*([A-Za-z0-9_-]+)/m.exec(text);
  if (!m) return true;
  const stack = m[1].toLowerCase();
  const wanted = LESSON_STACK_PACKS[stack] || [];
  return (packs || []).some((p) => wanted.includes(p) || p.split('/').pop() === stack);
}

function plural(n, w) { return `${n} ${w}${n === 1 ? '' : 's'}`; }
function safeJson(t) { try { return JSON.parse(t); } catch { return null; } }
function nowIso() { return new Date().toISOString(); }

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

// Remove a file and any now-empty parent directories, stopping at `stopAt`.
function removeAndPrune(absFile, stopAt) {
  try { fs.unlinkSync(absFile); } catch { /* already gone */ }
  let dir = path.dirname(absFile);
  while (dir.startsWith(stopAt) && dir !== stopAt) {
    try {
      if (fs.readdirSync(dir).length === 0) { fs.rmdirSync(dir); dir = path.dirname(dir); }
      else break;
    } catch { break; }
  }
}

// Detect AI config from other tools (Copilot, Cursor, Windsurf) so we can import it.
function detectForeignAiConfig(into) {
  const found = [];
  const files = [
    ['Copilot', '.github/copilot-instructions.md'],
    ['Cursor', '.cursorrules'],
    ['Windsurf', '.windsurfrules'],
    ['Aider', 'CONVENTIONS.md'],
  ];
  for (const [tool, rel] of files) if (exists(path.join(into, rel))) found.push({ tool, rel });
  const dirs = [
    ['Copilot', '.github/instructions', /\.instructions\.md$/],
    ['Copilot', '.github/agents', /\.agent\.md$/],
    ['Copilot', '.github/prompts', /\.prompt\.md$/],
    ['Cursor', '.cursor/rules', /\.mdc$/],
  ];
  for (const [tool, dir, re] of dirs) {
    const abs = path.join(into, dir);
    if (!exists(abs)) continue;
    for (const f of fs.readdirSync(abs)) if (re.test(f)) found.push({ tool, rel: `${dir}/${f}` });
  }
  return found;
}

// Existing .claude / .agents agents/commands/skills that engsys does NOT manage —
// the project's own (sub)agents and tooling. We preserve them, never prune them,
// and surface them so the operator (and /naturalize) can reconcile.
function detectPreexisting(into, managedSet) {
  const out = { agents: [], commands: [], skills: [] };
  for (const root of ['.claude', '.agents']) {
    for (const sub of ['agents', 'commands']) {
      const d = path.join(into, root, sub);
      if (!exists(d)) continue;
      for (const f of fs.readdirSync(d)) {
        if (!f.endsWith('.md')) continue;
        const rel = path.relative(into, path.join(d, f));
        if (!managedSet.has(rel)) out[sub].push(rel);
      }
    }
    const sd = path.join(into, root, 'skills');
    if (exists(sd)) for (const dir of fs.readdirSync(sd, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const rel = path.relative(into, path.join(sd, dir.name));
      const ours = [...managedSet].some((m) => m.startsWith(rel + path.sep));
      if (!ours) out.skills.push(rel + '/');
    }
  }
  return out;
}

function resolveLockPath(into) {
  const claudeLock = path.join(into, '.claude', 'engsys.lock');
  if (exists(claudeLock)) return claudeLock;
  const agyLock = path.join(into, '.agents', 'engsys.lock');
  if (exists(agyLock)) return agyLock;
  return claudeLock;
}

function resolveBackupRel(into, preferClaude) {
  if (typeof preferClaude === 'boolean') {
    return preferClaude ? BACKUP_DIR : '.agents/.engsys-backup';
  }
  const claudeManifest = path.join(into, BACKUP_DIR, 'manifest.json');
  const agyManifest = path.join(into, '.agents', '.engsys-backup', 'manifest.json');
  if (exists(claudeManifest) && exists(agyManifest)) {
    const cm = fs.statSync(claudeManifest).mtimeMs;
    const am = fs.statSync(agyManifest).mtimeMs;
    return am > cm ? '.agents/.engsys-backup' : BACKUP_DIR;
  }
  if (exists(path.join(into, BACKUP_DIR))) return BACKUP_DIR;
  if (exists(path.join(into, '.agents', '.engsys-backup'))) return '.agents/.engsys-backup';
  return BACKUP_DIR;
}

function readBackupManifest(backupAbs) {
  const mp = path.join(backupAbs, 'manifest.json');
  if (!exists(mp)) return null;
  const parsed = safeJson(readText(mp));
  if (!parsed || !Array.isArray(parsed.restore)) {
    throw new Error(`Corrupt rollback manifest at ${mp} — refusing to overwrite backup state.`);
  }
  return parsed;
}

function mergeBackupDirs(activeBackupAbs, otherBackupAbs, dryRun) {
  const activeManifest = readBackupManifest(activeBackupAbs);
  const otherManifest = readBackupManifest(otherBackupAbs);
  const restore = [];
  for (const m of [activeManifest, otherManifest]) {
    if (!m) continue;
    for (const rel of m.restore) {
      if (!restore.includes(rel)) restore.push(rel);
    }
  }
  if (!dryRun && exists(otherBackupAbs)) {
    const otherFilesDir = path.join(otherBackupAbs, 'files');
    const activeFilesDir = path.join(activeBackupAbs, 'files');
    if (exists(otherFilesDir)) {
      for (const f of walk(otherFilesDir)) {
        const rel = path.relative(otherFilesDir, f);
        const dest = path.join(activeFilesDir, rel);
        if (!exists(dest)) {
          ensureDir(path.dirname(dest));
          fs.copyFileSync(f, dest);
        }
      }
    }
    fs.rmSync(otherBackupAbs, { recursive: true, force: true });
  }
  const base = activeManifest || otherManifest;
  return {
    hadManifest: Boolean(base),
    snapshot: {
      engsysVersion: (base && base.engsysVersion) || ENGSYS_VERSION,
      createdAt: (base && base.createdAt) || nowIso(),
      restore,
    },
  };
}

function pruneEmptyDir(dir) {
  try {
    if (exists(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* ignore */ }
}

// Core install/update routine. mode: 'install' | 'update'.
function runInstall(opts) {
  const { engsysRoot, into, dryRun, force } = opts;
  const configPath = resolveConfigPath(into, opts.config);
  const config = loadConfig(configPath);
  const harness = render.normalizeHarness(opts.harness || config.harness);
  const harnesses = render.normalizeHarnesses(opts.harness || config.harness);
  const useClaude = harnesses.includes('claude') || harnesses.includes('copilot');
  const useCopilot = harnesses.includes('copilot');
  const useAntigravity = harnesses.includes('antigravity');
  const plan = buildManifest(engsysRoot, config);

  const claudeDir = path.join(into, '.claude');
  const agentsDir = path.join(into, '.agents');
  const claudeLockPath = path.join(claudeDir, 'engsys.lock');
  const agyLockPath = path.join(agentsDir, 'engsys.lock');
  const existingLockPath = resolveLockPath(into);
  const hadLock = exists(existingLockPath);
  const oldLock = hadLock ? (safeJson(readText(existingLockPath)) || {}) : null;
  const mode = (opts.mode === 'install' && hadLock) ? 'update' : opts.mode;
  const adopting = opts.mode === 'install' && hadLock;

  // Resolve and, if harness changed between .claude and .agents, merge the backup dirs.
  const activeBackupRel = resolveBackupRel(into, useClaude);
  const otherBackupRel = useClaude ? '.agents/.engsys-backup' : BACKUP_DIR;
  const activeBackupAbs = path.join(into, activeBackupRel);
  const otherBackupAbs = path.join(into, otherBackupRel);
  const { snapshot } = mergeBackupDirs(activeBackupAbs, otherBackupAbs, dryRun);

  // Rollback baseline: snapshot every pre-existing file engsys is about to
  // overwrite/merge — both on first install AND on any subsequent update that
  // expands into a new harness, pack, or optional agent for the first time.
  const firstInstall = !hadLock;
  const backupFilesDir = path.join(activeBackupAbs, 'files');
  const snapped = new Set(snapshot.restore);

  const managed = {};
  const generated = [];
  const imported = [];
  const warnings = [];
  const actions = [];
  const realPath = (f) => (fs.lstatSync(f).isSymbolicLink() ? fs.realpathSync(f) : f);

  const prevManaged = (oldLock && oldLock.managed) || {};
  const prevGenerated = new Set((oldLock && oldLock.generated) || []);
  const prevImported = new Set((oldLock && oldLock.imported) || []);
  const wasOurs = (rel) =>
    (rel in prevManaged) || prevGenerated.has(rel) || prevImported.has(rel) ||
    (rel in managed) || generated.includes(rel) || imported.includes(rel);

  const snapBefore = (destFile) => {
    const rel = path.relative(into, destFile);
    if (wasOurs(rel) || !exists(destFile)) return;
    const bdest = path.join(backupFilesDir, rel);
    if (snapped.has(rel) && (dryRun || exists(bdest))) return;
    if (!snapped.has(rel)) {
      snapped.add(rel);
      snapshot.restore.push(rel);
    }
    if (!dryRun) {
      ensureDir(path.dirname(bdest));
      fs.copyFileSync(destFile, bdest);
    }
  };

  const readBackupJson = (rel) => {
    for (const dir of [activeBackupAbs, otherBackupAbs]) {
      const p = path.join(dir, 'files', rel);
      if (exists(p)) return safeJson(readText(p));
    }
    return null;
  };

  const writeManaged = (srcFile, destFile) => {
    const rel = path.relative(into, destFile);
    const src = realPath(srcFile);
    const hash = sha256(readText(src));
    const owned = wasOurs(rel);
    if (!dryRun) {
      if (exists(destFile) && !owned && sha256(readText(destFile)) !== hash) {
        snapBefore(destFile);
        warnings.push(`overwrote the project's own ${rel} (original snapshotted for rollback)`);
      }
      ensureDir(path.dirname(destFile));
      fs.copyFileSync(src, destFile);
    } else if (exists(destFile) && !owned && sha256(readText(destFile)) !== hash) {
      snapBefore(destFile);
    }
    managed[rel] = hash;
    return rel;
  };

  const writeManagedText = (content, destFile) => {
    const rel = path.relative(into, destFile);
    const hash = sha256(content);
    const owned = wasOurs(rel);
    if (!dryRun) {
      if (exists(destFile) && !owned && sha256(readText(destFile)) !== hash) {
        snapBefore(destFile);
        warnings.push(`overwrote the project's own ${rel} (original snapshotted for rollback)`);
      }
      writeText(destFile, content);
    } else if (exists(destFile) && !owned && sha256(readText(destFile)) !== hash) {
      snapBefore(destFile);
    }
    managed[rel] = hash;
    return rel;
  };

  const corePluginHooks = ['handback-guard.mjs', 'subagent-memory-inject.mjs', 'weather-check.mjs']
    .map((name) => ({ name, src: path.join(engsysRoot, 'core', '.claude-plugin', name) }))
    .filter((h) => exists(h.src));

  // --- managed copies for Claude / Copilot (.claude/) ---
  if (useClaude) {
    for (const a of plan.agents) writeManaged(a.src, path.join(claudeDir, 'agents', a.name));
    for (const c of plan.commands) writeManaged(c.src, path.join(claudeDir, 'commands', c.name));
    for (const w of plan.workflows) writeManaged(w.src, path.join(claudeDir, 'workflows', w.name));
    for (const s of plan.scripts) writeManaged(s.src, path.join(claudeDir, 'scripts', s.name));
    for (const l of plan.libs) writeManaged(l.src, path.join(claudeDir, 'lib', l.name));
    for (const b of plan.briefAdapters) {
      writeManaged(b.src, path.join(claudeDir, 'workflows', 'briefs', 'adapters', b.name));
    }
    for (const ch of corePluginHooks) {
      writeManaged(ch.src, path.join(claudeDir, 'hooks', ch.name));
    }
    for (const h of plan.packHooks) {
      const rel = writeManaged(h.src, path.join(claudeDir, 'hooks', h.name));
      if (!dryRun) fs.chmodSync(path.join(into, rel), 0o755);
    }
    for (const s of plan.skillDirs) {
      const destDir = path.join(claudeDir, 'skills', s.name);
      if (dryRun) {
        for (const f of walk(s.src)) {
          const destFile = path.join(destDir, path.relative(s.src, f));
          snapBefore(destFile);
          const rel = path.relative(into, destFile);
          managed[rel] = sha256(readText(realPath(f)));
        }
      } else {
        for (const f of walk(s.src)) snapBefore(path.join(destDir, path.relative(s.src, f)));
        for (const rel of copyDir(s.src, destDir, into, [])) managed[rel] = sha256(readText(path.join(into, rel)));
      }
    }
  }

  // --- managed copies for Antigravity (.agents/) ---
  if (useAntigravity) {
    for (const a of plan.agents) {
      const translated = render.renderAntigravityAgent(readText(realPath(a.src)));
      writeManagedText(translated, path.join(agentsDir, 'agents', a.name));
    }
    const skillDirNames = new Set(plan.skillDirs.map((s) => s.name));
    for (const c of plan.commands) {
      const cmdStem = c.name.replace(/\.md$/, '');
      if (skillDirNames.has(cmdStem)) continue;
      const cmdSkillMd = render.renderCommandSkillMd(c.name, readText(realPath(c.src)));
      writeManagedText(cmdSkillMd, path.join(agentsDir, 'skills', cmdStem, 'SKILL.md'));
    }
    for (const w of plan.workflows) writeManaged(w.src, path.join(agentsDir, 'workflows', w.name));
    for (const s of plan.scripts) writeManaged(s.src, path.join(agentsDir, 'scripts', s.name));
    for (const l of plan.libs) writeManaged(l.src, path.join(agentsDir, 'lib', l.name));
    for (const b of plan.briefAdapters) {
      writeManaged(b.src, path.join(agentsDir, 'workflows', 'briefs', 'adapters', b.name));
    }
    for (const ch of corePluginHooks) {
      writeManaged(ch.src, path.join(agentsDir, 'hooks', ch.name));
    }
    for (const h of plan.packHooks) {
      const rel = writeManaged(h.src, path.join(agentsDir, 'hooks', h.name));
      if (!dryRun) fs.chmodSync(path.join(into, rel), 0o755);
    }
    for (const s of plan.skillDirs) {
      const destDir = path.join(agentsDir, 'skills', s.name);
      if (dryRun) {
        for (const f of walk(s.src)) {
          const destFile = path.join(destDir, path.relative(s.src, f));
          snapBefore(destFile);
          const rel = path.relative(into, destFile);
          managed[rel] = sha256(readText(realPath(f)));
        }
      } else {
        for (const f of walk(s.src)) snapBefore(path.join(destDir, path.relative(s.src, f)));
        for (const rel of copyDir(s.src, destDir, into, [])) managed[rel] = sha256(readText(path.join(into, rel)));
      }
    }
  }

  // --- seed lessons ---
  const lessonsCfg = config.lessons || {};
  let lessonsCount = 0;
  if (lessonsCfg.seed !== false) {
    const libDir = path.join(engsysRoot, 'core', 'lessons-library');
    const lessonsInto = lessonsCfg.into || 'docs/agent-lessons/library';
    if (exists(libDir)) {
      for (const f of fs.readdirSync(libDir)) {
        if (!f.endsWith('.md') || f === 'README.md') continue;
        if (!lessonAppliesToPacks(readText(path.join(libDir, f)), plan.packs)) continue;
        writeManaged(path.join(libDir, f), path.join(into, lessonsInto, f));
        lessonsCount++;
      }
    }
  }

  // --- scenario 3: import foreign AI config (Copilot/Cursor/…) on first install ---
  const foreign = detectForeignAiConfig(into);
  const importDir = path.join(into, 'docs', 'imported-ai-config');
  let importedNow = false;
  if (foreign.length && !exists(importDir) && opts.mode === 'install') {
    importedNow = true;
    const index = ['# Imported AI config', '',
      'Snapshots of pre-existing AI assistant config found at install time. Run',
      '`/naturalize` to fold the durable rules into `CLAUDE.md` (and convert any',
      'agent definitions to engsys agents). One-time snapshots — originals are left',
      'in place; delete this folder once folded in.', '', '| Tool | Original | Snapshot |', '|------|----------|----------|'];
    for (const { tool, rel } of foreign) {
      const flat = rel.replace(/^[./]+/, '').replace(/[/\\]/g, '__');
      if (!dryRun) writeText(path.join(importDir, flat), readText(path.join(into, rel)));
      imported.push(path.relative(into, path.join(importDir, flat)));
      index.push(`| ${tool} | \`${rel}\` | \`docs/imported-ai-config/${flat}\` |`);
    }
    if (!dryRun) writeText(path.join(importDir, 'README.md'), index.join('\n') + '\n');
    imported.push('docs/imported-ai-config/README.md');
  } else {
    for (const rel of prevImported) {
      if (exists(path.join(into, rel)) && !imported.includes(rel)) imported.push(rel);
    }
  }

  // --- generated files (always merge/preserve; never clobber) ---
  const claudeMdPath = path.join(into, 'CLAUDE.md');
  const agentsMdPath = path.join(into, 'AGENTS.md');
  const geminiMdPath = path.join(into, 'GEMINI.md');
  let existingRegion = null, seedFacts = null, foldedClaude = false;
  const candidateMdPaths = [claudeMdPath, agentsMdPath, geminiMdPath].filter((p) => exists(p));
  const fencedMdPath = candidateMdPaths.find((p) => readText(p).includes(PF_MARKER));
  if (fencedMdPath) {
    existingRegion = readText(fencedMdPath);
  }
  const activeMdTargets = [
    useClaude ? claudeMdPath : null,
    (useCopilot || useAntigravity) ? agentsMdPath : null,
    useAntigravity ? geminiMdPath : null,
  ].filter(Boolean);
  if (!force) {
    const unfencedBlocks = [];
    for (const mdPath of activeMdTargets) {
      if (!exists(mdPath)) continue;
      const rel = path.relative(into, mdPath);
      if (wasOurs(rel)) continue;
      const cur = readText(mdPath);
      if (cur.includes(PF_MARKER)) continue;
      foldedClaude = true;
      unfencedBlocks.push(
        `> Imported from this project's prior ${path.basename(mdPath)} (preserved for rollback in \`${activeBackupRel}/\`). Review and trim:\n\n${cur.trim()}`
      );
    }
    if (unfencedBlocks.length) {
      const joined = unfencedBlocks.join('\n\n---\n\n');
      if (existingRegion) {
        const endFence = '<!-- /ENGSYS:PROJECT-FACTS -->';
        const endIdx = existingRegion.indexOf(endFence);
        if (endIdx !== -1) {
          existingRegion = `${existingRegion.slice(0, endIdx).trimEnd()}\n\n${joined}\n${existingRegion.slice(endIdx)}`;
        }
      } else {
        seedFacts = joined;
      }
    }
  }
  if (importedNow && !seedFacts && !existingRegion) {
    seedFacts = '> TODO (naturalize): fold the imported rules in `docs/imported-ai-config/` into these project facts, then delete that folder.';
  }

  const claudeSettingsRel = path.relative(into, path.join(claudeDir, 'settings.json'));
  const existingSettings = exists(path.join(claudeDir, 'settings.json'))
    ? safeJson(readText(path.join(claudeDir, 'settings.json'))) : null;
  const existingMcp = exists(path.join(into, '.mcp.json'))
    ? safeJson(readText(path.join(into, '.mcp.json'))) : null;

  const legacyPlan = (oldLock && (!oldLock.engsysPermissions || !Array.isArray(oldLock.mcpServers)))
    ? buildManifest(engsysRoot, { stacks: oldLock.packs || [] })
    : null;
  const oldEngsysPermissions = oldLock
    ? (oldLock.engsysPermissions || render.computeEngsysPermissions(engsysRoot, legacyPlan))
    : null;
  const oldEngsysMcpServers = oldLock
    ? (Array.isArray(oldLock.mcpServers) ? oldLock.mcpServers : Object.keys((legacyPlan && legacyPlan.mcpServers) || {}))
    : null;

  const writeGen = (destFile, content, executable = false) => {
    snapBefore(destFile);
    if (!dryRun) {
      writeText(destFile, content);
      if (executable) fs.chmodSync(destFile, 0o755);
    }
    generated.push(path.relative(into, destFile));
  };

  // Seed a project-owned overlay file once (preserving edits across updates,
  // while tracking in `generated` when engsys created it so `uninstall` removes it).
  const seedOverlay = (destFile, content) => {
    const rel = path.relative(into, destFile);
    if (!exists(destFile)) {
      if (!dryRun) writeText(destFile, content);
      generated.push(rel);
      return true;
    }
    if (wasOurs(rel)) {
      if (force && !dryRun) writeText(destFile, content);
      generated.push(rel);
      return false;
    }
    if (force) {
      snapBefore(destFile);
      if (!dryRun) writeText(destFile, content);
      generated.push(rel);
      return true;
    }
    return false;
  };

  const renderedClaudeMd = render.renderClaudeMd(engsysRoot, config, plan, existingRegion, seedFacts);
  const renderedHookSh = render.renderHook(engsysRoot, config);
  const compactRegroundSh = readText(path.join(engsysRoot, 'core', 'templates', 'post-compact-reground.sh.tmpl'));
  const clearRegroundSh = readText(path.join(engsysRoot, 'core', 'templates', 'post-clear-reground.sh.tmpl'));
  const overlayTemplateText = readText(path.join(engsysRoot, 'core', 'templates', 'project-brief-overlay.md'));

  if (useClaude) {
    writeGen(claudeMdPath, renderedClaudeMd);
    const bkpClaudeSettings = readBackupJson(claudeSettingsRel);
    writeGen(
      path.join(claudeDir, 'settings.json'),
      render.renderSettings(engsysRoot, plan, force ? null : existingSettings, oldEngsysPermissions, bkpClaudeSettings)
    );
    writeGen(path.join(claudeDir, 'settings.local.json'), render.renderSettingsLocal(engsysRoot, plan));
    const bkpMcp = readBackupJson('.mcp.json');
    if (render.hasActiveMcpServers(plan, force ? null : existingMcp, oldEngsysMcpServers, bkpMcp)) {
      writeGen(path.join(into, '.mcp.json'), render.renderMcpJson(plan, force ? null : existingMcp, oldEngsysMcpServers, bkpMcp));
    }
    writeGen(path.join(claudeDir, 'hooks', 'post-edit-reminders.sh'), renderedHookSh, true);
    writeGen(path.join(claudeDir, 'hooks', 'post-compact-reground.sh'), compactRegroundSh, true);
    writeGen(path.join(claudeDir, 'hooks', 'post-clear-reground.sh'), clearRegroundSh, true);
  }

  if (useCopilot) {
    const copilotSettingsPath = path.join(into, '.github', 'copilot', 'settings.json');
    const copilotSettingsRel = path.relative(into, copilotSettingsPath);
    const existingCopilotSettings = exists(copilotSettingsPath)
      ? safeJson(readText(copilotSettingsPath)) : existingSettings;
    const bkpCopilotSettings = readBackupJson(copilotSettingsRel);
    writeGen(
      copilotSettingsPath,
      render.renderCopilotSettings(engsysRoot, plan, force ? null : existingCopilotSettings, oldEngsysPermissions, bkpCopilotSettings)
    );
  }

  if (useAntigravity) {
    writeGen(path.join(agentsDir, 'hooks.json'), render.renderAntigravityHooksJson(engsysRoot));
    writeGen(path.join(agentsDir, 'hooks', 'post-edit-reminders.sh'), renderedHookSh, true);
    writeGen(path.join(agentsDir, 'hooks', 'post-compact-reground.sh'), compactRegroundSh, true);
    writeGen(path.join(agentsDir, 'hooks', 'post-clear-reground.sh'), clearRegroundSh, true);
    const agyMcpPath = path.join(agentsDir, 'mcp_config.json');
    const agyMcpRel = path.relative(into, agyMcpPath);
    const existingAgyMcp = exists(agyMcpPath) ? safeJson(readText(agyMcpPath)) : existingMcp;
    const bkpAgyMcp = readBackupJson(agyMcpRel);
    if (render.hasActiveMcpServers(plan, force ? null : existingAgyMcp, oldEngsysMcpServers, bkpAgyMcp)) {
      writeGen(agyMcpPath, render.renderMcpJson(plan, force ? null : existingAgyMcp, oldEngsysMcpServers, bkpAgyMcp));
    }
    writeGen(geminiMdPath, render.renderAgentsMd(renderedClaudeMd, 'antigravity'));
  }

  if (useCopilot || useAntigravity) {
    writeGen(agentsMdPath, render.renderAgentsMd(renderedClaudeMd, useAntigravity && !useClaude ? 'antigravity' : 'copilot'));
  }

  // --- worker providers: machine-readable routing + project brief overlay (docs/memory-spec.md §11) ---
  const hasProviders = Object.keys(plan.providers || {}).length > 0;
  let overlaySeeded = false;
  if (hasProviders) {
    if (useClaude) writeGen(path.join(claudeDir, 'scripts', 'providers.json'), render.renderProvidersJson(config));
    if (useAntigravity) writeGen(path.join(agentsDir, 'scripts', 'providers.json'), render.renderProvidersJson(config));
  }
  if (useClaude) {
    if (seedOverlay(path.join(claudeDir, 'workflows', 'briefs', 'project-brief-overlay.md'), overlayTemplateText)) {
      overlaySeeded = true;
    }
  }
  if (useAntigravity) {
    if (seedOverlay(path.join(agentsDir, 'workflows', 'briefs', 'project-brief-overlay.md'), overlayTemplateText)) {
      overlaySeeded = true;
    }
  }

  // --- scenario 2: prune managed OR generated files orphaned since the last install ---
  const pruned = [];
  if (oldLock) {
    const oldTracked = new Set([
      ...Object.keys(prevManaged),
      ...prevGenerated,
    ]);
    for (const rel of oldTracked) {
      if (rel in managed || generated.includes(rel)) continue;
      const abs = path.join(into, rel);
      if (snapped.has(rel)) {
        const bsrc = path.join(backupFilesDir, rel);
        if (exists(bsrc)) {
          if (!dryRun) {
            ensureDir(path.dirname(abs));
            fs.copyFileSync(bsrc, abs);
            removeAndPrune(bsrc, backupFilesDir);
          }
          snapped.delete(rel);
          snapshot.restore = snapshot.restore.filter((r) => r !== rel);
        }
      } else if (!dryRun && exists(abs)) {
        removeAndPrune(abs, into);
      }
      pruned.push(rel);
    }
  }

  // Persist the rollback manifest across install and update.
  if (!dryRun) {
    writeText(path.join(activeBackupAbs, 'manifest.json'), JSON.stringify(snapshot, null, 2) + '\n');
  }

  const preexisting = detectPreexisting(into, new Set(Object.keys(managed)));
  const preexistingCount = preexisting.agents.length + preexisting.commands.length + preexisting.skills.length;

  const prev = (oldLock && oldLock.managed) || {};
  const changes = { added: 0, updated: 0, unchanged: 0, removed: pruned.length };
  for (const [rel, h] of Object.entries(managed)) {
    if (!(rel in prev)) changes.added++;
    else if (prev[rel] !== h) changes.updated++;
    else changes.unchanged++;
  }

  actions.push(`harness:   ${harness} (${harnesses.join(', ')})`);
  actions.push(`agents:    ${plural(plan.agents.length, 'file')}`);
  actions.push(`commands:  ${plural(plan.commands.length, 'file')}`);
  actions.push(`skills:    ${plural(plan.skillDirs.length, 'pack')}`);
  actions.push(`lessons:   ${plural(lessonsCount, 'file')} seeded`);
  actions.push(`workflows: ${plural(plan.workflows.length, 'file')}`);
  actions.push(`stack:     ${plan.packs.length ? plan.packs.join(', ') : 'none'}`);
  if (hasProviders) {
    actions.push(`providers: ${Object.keys(plan.providers).join(', ')}${overlaySeeded ? ' (brief overlay seeded — fill via /naturalize)' : ''}`);
  }

  const lock = {
    engsysVersion: ENGSYS_VERSION,
    engsysRef: (config.engsys && config.engsys.version) || null,
    configHash: sha256(readText(configPath)),
    harness,
    mode, packs: plan.packs,
    engsysPermissions: render.computeEngsysPermissions(engsysRoot, plan),
    mcpServers: Object.keys(plan.mcpServers || {}),
    managed, generated,
    imported: imported.length ? imported : undefined,
  };
  const lockJson = JSON.stringify(lock, null, 2) + '\n';
  if (!dryRun) {
    if (useClaude) {
      writeText(claudeLockPath, lockJson);
    } else if (exists(claudeLockPath)) {
      removeAndPrune(claudeLockPath, into);
      pruneEmptyDir(claudeDir);
    }
    if (useAntigravity) {
      writeText(agyLockPath, lockJson);
    } else if (exists(agyLockPath)) {
      removeAndPrune(agyLockPath, into);
      pruneEmptyDir(agentsDir);
    }
  }

  return {
    plan, actions, into, configPath, dryRun, mode, adopting, force, firstInstall,
    harness, harnesses,
    managedCount: Object.keys(managed).length, generated,
    snapshotted: snapshot.restore, foldedClaude,
    pruned, imported, importedNow, foreign, warnings, changes,
    preexisting, preexistingCount,
    versionFrom: oldLock ? oldLock.engsysVersion : null, versionTo: ENGSYS_VERSION,
  };
}

// uninstall: remove everything engsys added and restore the pre-install originals.
// The project's own agents/files (never in the lock) are left untouched.
function runUninstall(opts) {
  const { into, dryRun } = opts;
  const lockPath = resolveLockPath(into);
  if (!exists(lockPath)) throw new Error(`No engsys install found in ${into} (.claude/engsys.lock missing).`);
  const lock = JSON.parse(readText(lockPath));

  const backupRel = resolveBackupRel(into);
  const otherBackupRel = backupRel === BACKUP_DIR ? '.agents/.engsys-backup' : BACKUP_DIR;
  const activeBackupAbs = path.join(into, backupRel);
  const otherBackupAbs = path.join(into, otherBackupRel);
  const { hadManifest, snapshot: manifest } = mergeBackupDirs(activeBackupAbs, otherBackupAbs, dryRun);
  const restoreSet = new Set(manifest.restore || []);

  const engsysFiles = [
    ...Object.keys(lock.managed || {}),
    ...(lock.generated || []),
    ...(lock.imported || []),
  ];
  const removed = [], restored = [];

  // Delete engsys-created files (anything in the lock that wasn't a pre-existing original).
  for (const rel of engsysFiles) {
    if (restoreSet.has(rel)) continue;
    if (!dryRun && exists(path.join(into, rel))) removeAndPrune(path.join(into, rel), into);
    removed.push(rel);
  }
  // Restore originals engsys overwrote/merged.
  for (const rel of restoreSet) {
    const bsrc = [path.join(activeBackupAbs, 'files', rel), path.join(otherBackupAbs, 'files', rel)]
      .find((p) => exists(p));
    if (!bsrc) continue;
    if (!dryRun) { ensureDir(path.dirname(path.join(into, rel))); fs.copyFileSync(bsrc, path.join(into, rel)); }
    restored.push(rel);
  }
  // Remove engsys bookkeeping (locks + backup dirs + empty harness roots).
  if (!dryRun) {
    const claudeLockPath = path.join(into, '.claude', 'engsys.lock');
    const agyLockPath = path.join(into, '.agents', 'engsys.lock');
    if (exists(claudeLockPath)) removeAndPrune(claudeLockPath, into);
    if (exists(agyLockPath)) removeAndPrune(agyLockPath, into);
    fs.rmSync(path.join(into, BACKUP_DIR), { recursive: true, force: true });
    fs.rmSync(path.join(into, '.agents', '.engsys-backup'), { recursive: true, force: true });
    pruneEmptyDir(path.join(into, '.claude'));
    pruneEmptyDir(path.join(into, '.agents'));
    pruneEmptyDir(path.join(into, '.github', 'copilot'));
    pruneEmptyDir(path.join(into, '.github'));
    pruneEmptyDir(path.join(into, 'docs', 'agent-lessons', 'library'));
    pruneEmptyDir(path.join(into, 'docs', 'agent-lessons'));
    pruneEmptyDir(path.join(into, 'docs'));
  }
  return { into, dryRun, removed, restored, hadManifest,
    preexisting: detectPreexisting(into, new Set(Object.keys(lock.managed || {}))) };
}

// verify: compare on-disk managed files against the lock's hashes, then run
// the provider doctor (readiness matrix) when a worker layer is installed.
function runVerify(opts) {
  const { into } = opts;
  const lockPath = resolveLockPath(into);
  if (!exists(lockPath)) throw new Error(`No engsys.lock in ${into}/.claude — run install first.`);
  const lock = JSON.parse(readText(lockPath));
  const missing = [], modified = [];
  for (const [rel, hash] of Object.entries(lock.managed || {})) {
    const abs = path.join(into, rel);
    if (!exists(abs)) { missing.push(rel); continue; }
    if (sha256(readText(abs)) !== hash) modified.push(rel);
  }
  return {
    lock, missing, modified, ok: !missing.length && !modified.length,
    doctor: opts.skipDoctor ? null : runDoctor(into),
  };
}

// Provider doctor: each enabled adapter's --check, as a readiness matrix.
// Informational — readiness is environmental (a missing binary on CI is not
// drift), so it never changes verify's exit code; it changes what the operator
// knows before the next dispatch degrades into a loud exit 2.
function runDoctor(into) {
  const claudeProviders = path.join(into, '.claude', 'scripts', 'providers.json');
  const agyProviders = path.join(into, '.agents', 'scripts', 'providers.json');
  const providersPath = exists(claudeProviders) ? claudeProviders : (exists(agyProviders) ? agyProviders : null);
  if (!providersPath) return null;
  const providers = safeJson(readText(providersPath));
  if (!providers || !providers.workers) return null;
  const { spawnSync } = require('child_process');
  const scriptsRoot = path.dirname(providersPath);
  const runner = path.join(scriptsRoot, 'worker-run.mjs');
  const matrix = [];
  for (const name of Object.keys(providers.workers)) {
    const r = spawnSync('node', [runner, '--check', '--provider', name], {
      // 90s outer budget: must exceed the slowest adapter probe (grok's 60s
      // cold-start allowance) or the doctor kills a check its adapter would
      // have passed and misreports the environment.
      cwd: into, encoding: 'utf8', timeout: 90000,
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
    const detail = (out.match(/(?:READY|NOT READY) — (.*)$/m) || [])[1] || out.split('\n')[0] || '(no output)';
    matrix.push({ provider: name, ready: r.status === 0, detail });
  }
  return matrix;
}

// enable-providers: append a providers: block to the project config, then
// re-render. The one-command path onto the worker layer for existing installs —
// the alternative (hand-edit yaml, remember the block shape, run update, find
// the naturalize step) is exactly the plumbing-by-prose this installer exists
// to remove.
function runEnableProviders(opts) {
  const { engsysRoot, into, dryRun, providers } = opts;
  const configPath = resolveConfigPath(into, opts.config);
  const text = readText(configPath);
  // Never merge into an existing block: a deterministic append is verifiable,
  // a yaml surgery on user-owned formatting is not. Editing is the user's.
  if (/^providers\s*:/m.test(text)) {
    throw new Error(`${path.relative(into, configPath)} already has a providers: block — edit it directly, then run update.`);
  }
  const block = render.providersBlock(providers);
  if (!dryRun) {
    const lockPath = resolveLockPath(into);
    if (exists(lockPath)) {
      const backupRel = resolveBackupRel(into);
      const backupAbs = path.join(into, backupRel);
      const manifestPath = path.join(backupAbs, 'manifest.json');
      const manifest = readBackupManifest(backupAbs) || { engsysVersion: ENGSYS_VERSION, createdAt: nowIso(), restore: [] };
      const relCfg = path.relative(into, configPath);
      const bdest = path.join(backupAbs, 'files', relCfg);
      if (!manifest.restore.includes(relCfg) || !exists(bdest)) {
        ensureDir(path.dirname(bdest));
        fs.copyFileSync(configPath, bdest);
        if (!manifest.restore.includes(relCfg)) manifest.restore.push(relCfg);
        writeText(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      }
    }
    writeText(configPath, text.replace(/\n*$/, '\n') + block);
  }
  const result = dryRun
    ? null
    : runInstall({ engsysRoot, into, config: opts.config, dryRun: false, mode: 'update' });
  return { configPath, block, providers, result };
}

// ---------------------------------------------------------------------------
// fleet init — scaffold a new fleet instance repo from core/fleet/scaffold/.
//
// Templates use {{NAME}} tokens (the fleet kit's own __NAME__ tokens pass through
// untouched: they are rendered on the fleet host at launch time) and line-level
// conditionals — a line holding only {{#if flag}} / {{#unless flag}} opens a block,
// {{/if}} closes it. Flags: github_app, azure, marketplace, resource_broker, fleet.
// ---------------------------------------------------------------------------
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
// Same rule as core/fleet/lib/federation.mjs and fleet-env.sh.
const FLEET_ID_RE = /^[a-z][a-z0-9-]{1,20}$/;

function scaffoldRender(text, vars, flags, name) {
  const out = [];
  const stack = []; // one boolean per open block: is this block emitting?
  for (const line of text.split('\n')) {
    const open = line.match(/^\s*\{\{#(if|unless) (\w+)\}\}\s*$/);
    if (open) {
      if (!(open[2] in flags)) throw new Error(`${name}: unknown flag '${open[2]}'`);
      stack.push(open[1] === 'if' ? flags[open[2]] : !flags[open[2]]);
      continue;
    }
    if (/^\s*\{\{\/(if|unless)\}\}\s*$/.test(line)) {
      if (!stack.length) throw new Error(`${name}: unbalanced {{/if}}`);
      stack.pop();
      continue;
    }
    if (stack.every(Boolean)) out.push(line);
  }
  if (stack.length) throw new Error(`${name}: unclosed {{#if}} block`);
  const rendered = out.join('\n').replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (_, key) => {
    if (!(key in vars)) throw new Error(`${name}: unknown placeholder {{${key}}}`);
    return vars[key];
  });
  if (rendered.includes('{{')) throw new Error(`${name}: unrendered {{…}} token left over`);
  return rendered;
}

function fleetInitVars(opts) {
  const need = (v, flag) => { if (!v) throw new Error(`${flag} is required`); return v; };
  const org = need(opts.org, '--org');
  const namespace = need(opts.namespace, '--namespace');
  const pinRepo = need(opts.pinRepo, '--pin-repo');
  const pinDir = need(opts.pinDir, '--pin-dir');
  const marketplace = opts.instanceMarketplace || '';
  const identity = opts.identity || 'none';
  const cloud = opts.cloud || 'none';
  const rawHarness = opts.harness ? String(opts.harness).trim().toLowerCase() : 'claude';
  const harness = rawHarness === 'agy' ? 'antigravity' : rawHarness;
  if (!['claude', 'copilot', 'antigravity'].includes(harness)) {
    throw new Error(`--harness must be claude, copilot, or antigravity: ${opts.harness}`);
  }
  if (!SLUG_RE.test(org)) throw new Error(`--org must be a lowercase slug (letters, digits, hyphens): ${org}`);
  if (!SLUG_RE.test(namespace)) throw new Error(`--namespace must be a lowercase slug (letters, digits, hyphens): ${namespace}`);
  if (!REPO_RE.test(pinRepo)) throw new Error(`--pin-repo must be owner/name: ${pinRepo}`);
  if (marketplace && !SLUG_RE.test(marketplace)) throw new Error(`--instance-marketplace must be a lowercase slug: ${marketplace}`);
  if (!['github-app', 'none'].includes(identity)) throw new Error(`--identity must be github-app or none: ${identity}`);
  if (!['azure', 'none'].includes(cloud)) throw new Error(`--cloud must be azure or none: ${cloud}`);
  if (opts.fleet !== undefined && !FLEET_ID_RE.test(opts.fleet || '')) {
    throw new Error(`--fleet must be 2-21 characters: a lowercase letter, then lowercase letters, digits or hyphens: ${opts.fleet}`);
  }
  const fleetId = opts.fleet || '';
  const engsysDir = opts.engsysDir || '~/git/engsys';
  const paths = { '--pin-dir': pinDir, '--engsys-dir': engsysDir };
  if (opts.worktreesDir) paths['--worktrees-dir'] = opts.worktreesDir;
  for (const [flag, p] of Object.entries(paths)) {
    if (!/^(\/|~)/.test(p)) throw new Error(`${flag} must be an absolute path or start with ~: ${p}`);
    if (/[\s|#]/.test(p)) throw new Error(`${flag} must not contain whitespace, '|' or '#' (the fleet kit splits commands on them): ${p}`);
  }
  const parent = path.posix.dirname(pinDir);
  const worktreesDir = opts.worktreesDir || `${['.', '~'].includes(parent) ? '~' : parent}/worktrees`;
  const [owner, repo] = pinRepo.split('/');
  const configDirRel = `${marketplace ? 'plugin' : 'fleet'}/repos/${owner}/${repo}`;
  const vars = {
    ORG: org,
    NAMESPACE: namespace,
    PIN_REPO: pinRepo,
    PIN_DIR: pinDir,
    ENGSYS_DIR: engsysDir,
    WORKTREES_DIR: worktreesDir,
    INSTANCE_MARKETPLACE: marketplace,
    HARNESS: harness,
    GH_APP_ENV: identity === 'github-app' ? `~/.config/${org}/gh-app.env` : '',
    AZURE_SP_ENV: cloud === 'azure' ? `~/.config/${org}/azure-sp.env` : '',
    // With an instance plugin the SessionStart hook injects the config dir; without one the
    // roster passes it to the monsters in their prompt.
    CONFIG_DIR_ARG: marketplace ? '' : ` fleet config dir: __FLEET_REPO__/${configDirRel}`,
    TODAY: new Date().toISOString().slice(0, 10),
    FLEET_ID: fleetId,
    PIN_OWNER: pinRepo.split('/')[0],
  };
  const resourceBroker = !!opts.resourceBroker;
  const flags = {
    github_app: identity === 'github-app',
    azure: cloud === 'azure',
    marketplace: !!marketplace,
    resource_broker: resourceBroker,
    fleet: !!fleetId,
    harness_claude: harness === 'claude',
    harness_copilot: harness === 'copilot',
    harness_antigravity: harness === 'antigravity',
  };
  return { vars, flags, org, namespace, pinRepo, marketplace, identity, cloud, harness, engsysDir, configDirRel, resourceBroker, fleetId };
}

// The monster configs start life as the skills' own config.example.yml, with this instance's repo
// and session namespace filled in.
function monsterConfig(engsysRoot, skill, v) {
  const src = path.join(engsysRoot, 'core', 'skills', skill, 'config.example.yml');
  if (!exists(src)) throw new Error(`monster config example not found: ${src}`);
  return readText(src)
    .replace(/^repo: owner\/name/m, () => `repo: ${v.pinRepo}`)
    .replace(/<ns>/g, () => v.namespace);
}

// The optional resource broker: its config example names the pool file acme-pool.json; the scaffold
// writes the example pool file under this instance's namespace, with a name and bookkeeper owner that
// satisfy the owner fence the config sets (`^<ns>-...$`). The slot table is the example's; the
// operator edits it to describe the host's real resources.
function brokerPoolFile(v) { return `${v.namespace}-pool.json`; }

function brokerFiles(engsysRoot, v) {
  const cfg = monsterConfig(engsysRoot, 'resource-broker', v).replace(/^(\s*pool_file:\s*)acme-pool\.json/m, (_, k) => `${k}${brokerPoolFile(v)}`);
  const poolSrc = path.join(engsysRoot, 'core', 'skills', 'resource-broker', 'acme-pool.json');
  if (!exists(poolSrc)) throw new Error(`example pool file not found: ${poolSrc}`);
  const pool = readText(poolSrc)
    .replace('"name": "acme-pool"', () => `"name": "${v.namespace}-pool"`)
    .replace('"bookkeeper": "acme-broker"', () => `"bookkeeper": "${v.namespace}-broker"`);
  return [['resource-broker.yml', cfg], [brokerPoolFile(v), pool]];
}

function runFleetInit(opts) {
  const { engsysRoot, into } = opts;
  const v = fleetInitVars(opts);
  const scaffold = path.join(engsysRoot, 'core', 'fleet', 'scaffold');
  if (!exists(scaffold)) throw new Error(`scaffold not found: ${scaffold}`);
  const read = (rel) => readText(path.join(scaffold, rel));

  // [dest, content, executable]
  const files = [];
  const add = (dest, rel, exec) => files.push([dest, scaffoldRender(read(rel), v.vars, v.flags, rel), !!exec]);
  add('fleet/fleet.conf', 'fleet/fleet.conf');
  add('fleet/roster.tmpl', 'fleet/roster.tmpl');
  add('fleet/env/session.env.tmpl', 'fleet/env/session.env.tmpl');
  add('fleet/env/security.env.tmpl', 'fleet/env/security.env.tmpl');
  add('fleet/supervisor.conf.tmpl', 'fleet/supervisor.conf.tmpl');
  add('scripts/fleet', 'scripts/fleet', true);
  add('.gitignore', '_gitignore');
  add('README.md', 'README.md');
  add('docs/TRANSITION.md', 'docs/TRANSITION.md');
  if (v.fleetId) add('federation.yml', 'federation.yml');
  if (v.cloud === 'azure') add('jobs/launchd/az-sp-login.plist.tmpl', 'jobs/launchd/az-sp-login.plist.tmpl');
  const cfgDir = v.configDirRel;
  if (v.marketplace) {
    add('.claude-plugin/marketplace.json', '.claude-plugin/marketplace.json');
    add('plugin/.claude-plugin/plugin.json', 'plugin/.claude-plugin/plugin.json');
    add('plugin/hooks/hooks.json', 'plugin/hooks/hooks.json');
    add('plugin/hooks/fleet-context.sh', 'plugin/hooks/fleet-context.sh', true);
    add('plugin/context/org.md', 'plugin/context/org.md');
    add(`${cfgDir}/context.md`, 'repo/context.md');
  }
  files.push([`${cfgDir}/merge-monster.yml`, monsterConfig(engsysRoot, 'merge-monster', v), false]);
  files.push([`${cfgDir}/maintenance-monster.yml`, monsterConfig(engsysRoot, 'maintenance-monster', v), false]);
  if (v.resourceBroker) {
    for (const [name, content] of brokerFiles(engsysRoot, v)) files.push([`${cfgDir}/${name}`, content, false]);
  }

  const existing = files.map(([rel]) => rel).filter((rel) => exists(path.join(into, rel)));
  if (existing.length && !opts.force) {
    throw new Error(`refusing to overwrite ${existing.length} existing file(s) (use --force):\n  ${existing.join('\n  ')}`);
  }
  if (!opts.dryRun) {
    for (const [rel, content, exec] of files) {
      const abs = path.join(into, rel);
      writeText(abs, content);
      if (exec) fs.chmodSync(abs, 0o755);
    }
  }
  return { into, files: files.map(([rel]) => rel), overwritten: existing, vars: v.vars, ...v };
}

function fleetInitReport(r, args) {
  const V = r.vars;
  const lines = [];
  lines.push(...r.files.map((f) => `  ${r.overwritten.includes(f) ? 'overwrote' : 'wrote    '} ${f}`));
  const engsys = V.ENGSYS_DIR;
  const mkt = r.marketplace;
  lines.push('', 'Next steps:');
  lines.push('  1. Put the instance under version control and push it (the host checks it out at a pinned tag):');
  lines.push(`       cd ${args.into} && git init && git add -A && git commit -m "Initial fleet instance"`);
  lines.push('       git remote add origin <url> && git push -u origin main');
  lines.push('  2. Create the ledgers (labels + a pinned ledger issue per monster; the scripts are idempotent):');
  lines.push(`       ${engsys}/core/skills/merge-monster/scripts/mm-setup.sh --repo ${r.pinRepo}`);
  lines.push(`       ${engsys}/core/skills/maintenance-monster/scripts/mnt-setup.sh --repo ${r.pinRepo}`);
  if (r.resourceBroker) {
    lines.push(`       ${engsys}/core/skills/resource-broker/scripts/broker-setup.sh --repo ${r.pinRepo}`);
  }
  lines.push('     Each prints its ledger issue number. Put it in fleet/supervisor.conf.tmpl (replace the 0 on that');
  lines.push(`     session's line) and in ledger_issue of ${r.configDirRel}/merge-monster.yml, maintenance-monster.yml${r.resourceBroker ? ' and resource-broker.yml' : ''}.`);
  if (r.resourceBroker) {
    lines.push(`     Resource broker: edit ${r.configDirRel}/${brokerPoolFile(r)} (the slot table and the provision / health commands`);
    lines.push(`     that describe the host's real resources; see ${engsys}/core/skills/durable-lease/SKILL.md) and the lease.* and host.*`);
    lines.push('     keys of resource-broker.yml. Every session that takes slots must use that pool file, its store and an owner the fence accepts.');
  }
  if (r.fleetId) {
    lines.push(`     Multi-fleet: put the ledger numbers in federation.yml too (repos.${r.pinRepo}.merge / .maintain ledger:), fill in`);
    lines.push(`     the fleet's TODO fields and operators_team, then check it: scripts/fleet federation validate`);
  }
  lines.push('  3. Set up identity:');
  if (r.identity === 'github-app') {
    lines.push(`       GitHub App: create it and write ${V.GH_APP_ENV} following ${engsys}/core/fleet/identity/README.md`);
    lines.push(`       check it with: bash ${engsys}/core/fleet/identity/gh-app-login.sh ${V.GH_APP_ENV}`);
  } else {
    lines.push('       none: the fleet runs as the host\'s own gh and git login. Set GH_APP_ENV in fleet/fleet.conf later to');
    lines.push(`       adopt a GitHub App (${engsys}/core/fleet/identity/README.md).`);
  }
  if (r.cloud === 'azure') {
    lines.push(`       Azure: write ${V.AZURE_SP_ENV} following ${engsys}/stacks/cloud/azure/fleet/README.md`);
  }
  lines.push(`  4. Pin the plugins in ${r.pinRepo}'s .claude/settings.json (the pins are the single source of truth):`);
  const pins = { engsys: { source: { source: 'github', repo: 'eric-sabe/engsys', ref: `v${ENGSYS_VERSION}` } } };
  const enabled = { 'engsys@engsys': true };
  if (mkt) {
    pins[mkt] = { source: { source: 'github', repo: `${r.org}/<instance-repo>`, ref: 'v0.1.0' } };
    enabled[`${mkt}@${mkt}`] = true;
  }
  const snippet = JSON.stringify({ extraKnownMarketplaces: pins, enabledPlugins: enabled }, null, 2);
  lines.push(...snippet.split('\n').map((l) => `       ${l}`));
  lines.push('     Add the engsys stack plugins your repo uses (engsys-<stack>@engsys) to enabledPlugins too.');
  if (mkt) lines.push('     Tag this repo v0.1.0 and push the tag first; `scripts/fleet pin` cuts later instance releases.');
  lines.push('  5. On the fleet host:');
  lines.push(`       git clone https://github.com/eric-sabe/engsys.git ${engsys}   # if it is not there yet`);
  lines.push(`       cd ${args.into}`);
  lines.push('       scripts/fleet sync           # checkouts and plugins to the pins');
  lines.push('       scripts/fleet launch         # start the sessions in tmux');
  lines.push('       scripts/fleet install-jobs   # the launchd jobs (supervisor' + (r.identity === 'github-app' ? ', identity check' : '') + (r.cloud === 'azure' ? ', Azure login' : '') + ')');
  lines.push('     Then fill in docs/TRANSITION.md while you still remember who owns what.');
  return lines.join('\n');
}

module.exports = { runInstall, runUninstall, runVerify, runEnableProviders, runFleetInit, fleetInitReport, lessonAppliesToPacks, ENGSYS_VERSION };
