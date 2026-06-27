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

// Existing .claude agents/commands/skills that engsys does NOT manage — the
// project's own (sub)agents and tooling. We preserve them, never prune them,
// and surface them so the operator (and /naturalize) can reconcile.
function detectPreexisting(into, managedSet) {
  const out = { agents: [], commands: [], skills: [] };
  for (const sub of ['agents', 'commands']) {
    const d = path.join(into, '.claude', sub);
    if (!exists(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.md')) continue;
      const rel = path.relative(into, path.join(d, f));
      if (!managedSet.has(rel)) out[sub].push(rel);
    }
  }
  const sd = path.join(into, '.claude', 'skills');
  if (exists(sd)) for (const dir of fs.readdirSync(sd, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const rel = path.relative(into, path.join(sd, dir.name));
    const ours = [...managedSet].some((m) => m.startsWith(rel + path.sep));
    if (!ours) out.skills.push(rel + '/');
  }
  return out;
}

// Core install/update routine. mode: 'install' | 'update'.
function runInstall(opts) {
  const { engsysRoot, into, dryRun, force } = opts;
  const configPath = resolveConfigPath(into, opts.config);
  const config = loadConfig(configPath);
  const plan = buildManifest(engsysRoot, config);

  const claudeDir = path.join(into, '.claude');
  const lockPath = path.join(claudeDir, 'engsys.lock');
  const hadLock = exists(lockPath);
  const oldLock = hadLock ? (safeJson(readText(lockPath)) || {}) : null;
  const mode = (opts.mode === 'install' && hadLock) ? 'update' : opts.mode;
  const adopting = opts.mode === 'install' && hadLock;

  // Rollback baseline: on a genuine first install, snapshot every pre-existing
  // file engsys is about to overwrite/merge into .claude/.engsys-backup/, so
  // `engsys uninstall` can restore the project's prior system exactly.
  const firstInstall = !hadLock;
  const backupFilesDir = path.join(into, BACKUP_DIR, 'files');
  const snapshot = { engsysVersion: ENGSYS_VERSION, createdAt: nowIso(), restore: [] };
  const snapped = new Set();
  const snapBefore = (destFile) => {
    if (!firstInstall || dryRun) return;
    const rel = path.relative(into, destFile);
    if (snapped.has(rel) || !exists(destFile)) { snapped.add(rel); return; }
    snapped.add(rel);
    const bdest = path.join(backupFilesDir, rel);
    ensureDir(path.dirname(bdest));
    fs.copyFileSync(destFile, bdest);
    snapshot.restore.push(rel);
  };

  const managed = {};
  const generated = [];
  const imported = [];
  const warnings = [];
  const actions = [];
  const realPath = (f) => (fs.lstatSync(f).isSymbolicLink() ? fs.realpathSync(f) : f);

  const writeManaged = (srcFile, destFile) => {
    const rel = path.relative(into, destFile);
    const src = realPath(srcFile);
    const hash = sha256(readText(src));
    const wasOurs = oldLock && oldLock.managed && rel in oldLock.managed;
    if (!dryRun) {
      if (exists(destFile) && !wasOurs && sha256(readText(destFile)) !== hash) {
        snapBefore(destFile);
        warnings.push(`overwrote the project's own ${rel} (original snapshotted for rollback)`);
      }
      ensureDir(path.dirname(destFile));
      fs.copyFileSync(src, destFile);
    }
    managed[rel] = hash;
    return rel;
  };

  // --- managed copies ---
  for (const a of plan.agents) writeManaged(a.src, path.join(claudeDir, 'agents', a.name));
  for (const c of plan.commands) writeManaged(c.src, path.join(claudeDir, 'commands', c.name));
  for (const w of plan.workflows) writeManaged(w.src, path.join(claudeDir, 'workflows', w.name));
  for (const h of plan.packHooks) {
    const rel = writeManaged(h.src, path.join(claudeDir, 'hooks', h.name));
    if (!dryRun) fs.chmodSync(path.join(into, rel), 0o755);
  }
  for (const s of plan.skillDirs) {
    const destDir = path.join(claudeDir, 'skills', s.name);
    if (dryRun) {
      for (const f of walk(s.src)) {
        const rel = path.relative(into, path.join(destDir, path.relative(s.src, f)));
        managed[rel] = sha256(readText(realPath(f)));
      }
    } else {
      for (const f of walk(s.src)) snapBefore(path.join(destDir, path.relative(s.src, f)));
      for (const rel of copyDir(s.src, destDir, into, [])) managed[rel] = sha256(readText(path.join(into, rel)));
    }
  }

  // --- seed lessons ---
  const lessonsCfg = config.lessons || {};
  let lessonsCount = 0;
  if (lessonsCfg.seed !== false) {
    const libDir = path.join(engsysRoot, 'lessons-library');
    const lessonsInto = lessonsCfg.into || 'docs/agent-lessons/library';
    if (exists(libDir)) {
      for (const f of fs.readdirSync(libDir)) {
        if (!f.endsWith('.md') || f === 'README.md') continue;
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
  }

  // --- generated files (always merge/preserve; never clobber) ---
  const claudeMdPath = path.join(into, 'CLAUDE.md');
  let existingRegion = null, seedFacts = null, foldedClaude = false;
  if (exists(claudeMdPath)) {
    const cur = readText(claudeMdPath);
    if (cur.includes(PF_MARKER)) {
      existingRegion = cur;
    } else if (!force) {
      foldedClaude = true;
      seedFacts = `> Imported from this project's prior CLAUDE.md (preserved for rollback in \`${BACKUP_DIR}/\`). Review and trim:\n\n${cur.trim()}`;
    }
  }
  if (importedNow && !seedFacts && !existingRegion) {
    seedFacts = '> TODO (naturalize): fold the imported rules in `docs/imported-ai-config/` into these project facts, then delete that folder.';
  }

  const existingSettings = exists(path.join(claudeDir, 'settings.json'))
    ? safeJson(readText(path.join(claudeDir, 'settings.json'))) : null;
  const existingMcp = exists(path.join(into, '.mcp.json'))
    ? safeJson(readText(path.join(into, '.mcp.json'))) : null;

  const writeGen = (destFile, content) => {
    snapBefore(destFile);
    if (!dryRun) writeText(destFile, content);
    generated.push(path.relative(into, destFile));
  };

  writeGen(claudeMdPath, render.renderClaudeMd(engsysRoot, config, plan, existingRegion, seedFacts));
  writeGen(path.join(claudeDir, 'settings.json'), render.renderSettings(engsysRoot, plan, force ? null : existingSettings));
  writeGen(path.join(claudeDir, 'settings.local.json'), render.renderSettingsLocal(engsysRoot, plan));
  if (Object.keys(plan.mcpServers).length || existingMcp) {
    writeGen(path.join(into, '.mcp.json'), render.renderMcpJson(plan, force ? null : existingMcp));
  }
  const hookDest = path.join(claudeDir, 'hooks', 'post-edit-reminders.sh');
  snapBefore(hookDest);
  if (!dryRun) { writeText(hookDest, render.renderHook(engsysRoot, config)); fs.chmodSync(hookDest, 0o755); }
  generated.push(path.relative(into, hookDest));

  // Write the rollback manifest (first install only).
  if (firstInstall && !dryRun) {
    writeText(path.join(into, BACKUP_DIR, 'manifest.json'), JSON.stringify(snapshot, null, 2) + '\n');
  }

  // --- scenario 2: prune managed files orphaned since the last install ---
  const pruned = [];
  if (oldLock && oldLock.managed) {
    for (const rel of Object.keys(oldLock.managed)) {
      if (rel in managed || generated.includes(rel)) continue;
      if (!dryRun && exists(path.join(into, rel))) removeAndPrune(path.join(into, rel), into);
      pruned.push(rel);
    }
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

  actions.push(`agents:    ${plural(plan.agents.length, 'file')}`);
  actions.push(`commands:  ${plural(plan.commands.length, 'file')}`);
  actions.push(`skills:    ${plural(plan.skillDirs.length, 'pack')}`);
  actions.push(`lessons:   ${plural(lessonsCount, 'file')} seeded`);
  actions.push(`workflows: ${plural(plan.workflows.length, 'file')}`);
  actions.push(`stack:     ${plan.packs.length ? plan.packs.join(', ') : 'none'}`);

  const lock = {
    engsysVersion: ENGSYS_VERSION,
    engsysRef: (config.engsys && config.engsys.version) || null,
    configHash: sha256(readText(configPath)),
    mode, packs: plan.packs, managed, generated,
    imported: imported.length ? imported : undefined,
  };
  if (!dryRun) writeText(lockPath, JSON.stringify(lock, null, 2) + '\n');

  return {
    plan, actions, into, configPath, dryRun, mode, adopting, force, firstInstall,
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
  const claudeDir = path.join(into, '.claude');
  const lockPath = path.join(claudeDir, 'engsys.lock');
  if (!exists(lockPath)) throw new Error(`No engsys install found in ${into} (.claude/engsys.lock missing).`);
  const lock = JSON.parse(readText(lockPath));

  const manifestPath = path.join(into, BACKUP_DIR, 'manifest.json');
  const hadManifest = exists(manifestPath);
  const manifest = hadManifest ? (safeJson(readText(manifestPath)) || { restore: [] }) : { restore: [] };
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
    const bsrc = path.join(into, BACKUP_DIR, 'files', rel);
    if (!exists(bsrc)) continue;
    if (!dryRun) { ensureDir(path.dirname(path.join(into, rel))); fs.copyFileSync(bsrc, path.join(into, rel)); }
    restored.push(rel);
  }
  // Remove engsys bookkeeping (lock + backup dir).
  if (!dryRun) {
    removeAndPrune(lockPath, into);
    fs.rmSync(path.join(into, BACKUP_DIR), { recursive: true, force: true });
  }
  return { into, dryRun, removed, restored, hadManifest,
    preexisting: detectPreexisting(into, new Set(Object.keys(lock.managed || {}))) };
}

// verify: compare on-disk managed files against the lock's hashes.
function runVerify(opts) {
  const { into } = opts;
  const lockPath = path.join(into, '.claude', 'engsys.lock');
  if (!exists(lockPath)) throw new Error(`No engsys.lock in ${into}/.claude — run install first.`);
  const lock = JSON.parse(readText(lockPath));
  const missing = [], modified = [];
  for (const [rel, hash] of Object.entries(lock.managed || {})) {
    const abs = path.join(into, rel);
    if (!exists(abs)) { missing.push(rel); continue; }
    if (sha256(readText(abs)) !== hash) modified.push(rel);
  }
  return { lock, missing, modified, ok: !missing.length && !modified.length };
}

module.exports = { runInstall, runUninstall, runVerify, ENGSYS_VERSION };
