#!/usr/bin/env node
/**
 * Generate team-roster headshots for engsys agent personas.
 *
 * The image prompt is derived FROM the agent profile itself — the script reads
 * the persona's name, role, and personality straight out of the .md and wraps it
 * in a consistent "house style" art direction. Point it at any agent profile.
 *
 * Config (from .env at the repo root, or the environment):
 *   OPENAI_API_KEY        required
 *   OPENAI_IMAGE_MODEL    e.g. gpt-image-1 (default) or dall-e-3
 *   OPENAI_IMAGE_QUALITY  optional override (gpt-image-1: low|medium|high|auto;
 *                                            dall-e-3: standard|hd)
 *
 * Usage:
 *   node lib/generate-team-avatars.mjs <agent.md> [<agent.md> ...] [options]
 *
 * Options:
 *   --count=N     how many variations to generate per profile (1-5, default 1)
 *   --out=DIR     output directory (default: tmp/ at the repo root)
 *   --dry-run     print the constructed prompt(s) and exit — no API call, no cost
 *
 * Examples:
 *   node lib/generate-team-avatars.mjs optional-agents/sandy.md --count=3
 *   node lib/generate-team-avatars.mjs core/agents/*.md --count=2
 *   node lib/generate-team-avatars.mjs optional-agents/gary.md --dry-run
 *
 * Output files are versioned (sandy-001.png, sandy-002.png, …) and never
 * overwrite existing files. Pick the winner, then move it to team-images/<id>.png.
 */

import fs from 'fs';
import path from 'path';
import process from 'node:process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

// --- config / .env ---------------------------------------------------------
const ENV_PATH = path.join(REPO_ROOT, '.env');
if (fs.existsSync(ENV_PATH)) {
  try {
    process.loadEnvFile(ENV_PATH); // Node >= 20.12 / 22
  } catch {
    // minimal fallback parser (KEY=VALUE per line, ignores # comments)
    for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (m && !line.trimStart().startsWith('#')) {
        const val = m[2].replace(/^["']|["']$/g, '');
        if (!(m[1] in process.env)) process.env[m[1]] = val;
      }
    }
  }
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const API_URL = 'https://api.openai.com/v1/images/generations';

// --- prompt construction ---------------------------------------------------

// Pull name / role / personality out of an agent profile .md.
function extractPersona(md, fallbackId) {
  let name = fallbackId;
  let description = '';
  let body = md;

  if (md.startsWith('---')) {
    const end = md.indexOf('\n---', 3);
    if (end !== -1) {
      const fm = md.slice(3, end);
      const nm = fm.match(/^\s*name:\s*(.+)$/m);
      if (nm) name = nm[1].trim().replace(/^["']|["']$/g, '');
      const dm = fm.match(/^\s*description:\s*(.+)$/m);
      if (dm) description = dm[1].trim().replace(/^["']|["']$/g, '');
      body = md.slice(end + 4);
    }
  }

  const titleMatch = body.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : (name.charAt(0).toUpperCase() + name.slice(1));

  // The Personality section is the richest source of look-and-vibe cues.
  let personality = '';
  const pm = body.match(/^#{2,3}\s*Personality[^\n]*\n([\s\S]*?)(?=\n#{2,3}\s|$)/im);
  if (pm) personality = pm[1].trim();
  if (!personality) {
    // fall back to the opening prose of the profile
    personality = body.replace(/^#.*$/m, '').trim().slice(0, 1200);
  }

  return { id: name, title, description, personality };
}

function clip(s, n) {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + '…' : s;
}

function buildPrompt({ title, description, personality }, appearance) {
  const brief = [
    description && `Role: ${clip(description, 400)}`,
    personality && `Personality & vibe:\n${clip(personality, 1400)}`,
  ].filter(Boolean).join('\n\n');

  const likeness = appearance ? `\nPhysical likeness (use exactly, this overrides any inference): ${appearance}.\n` : '';

  return `An illustrated character portrait for a software-engineering team roster — a single trading-card-style avatar.

Subject: ${title}.
${likeness}
${brief}

Art direction: a warm, characterful, stylized DIGITAL PORTRAIT ILLUSTRATION (clearly illustrated, NOT photorealistic) of one person who naturally embodies the personality above. Choose an age, build, clothing, expression, and one small thematic prop that fit the role and character. Head and upper chest only, face centered with generous padding on every side so it can be cropped to a circle without clipping. Tasteful thematic gradient background with subtle motifs related to the role. Friendly, professional, a touch playful. Consistent, clean illustrative style. Square 1024x1024.`;
}

// --- generation ------------------------------------------------------------

function nextVersion(dir, id) {
  if (!fs.existsSync(dir)) return 1;
  const re = new RegExp(`^${id}-(\\d{3})\\.png$`);
  let max = 0;
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

function requestBody(prompt) {
  const body = { model: MODEL, prompt, n: 1, size: '1024x1024' };
  const q = process.env.OPENAI_IMAGE_QUALITY;
  if (MODEL === 'dall-e-3') {
    body.quality = q || 'standard';     // standard | hd
    body.response_format = 'b64_json';
  } else {
    body.quality = q || 'high';         // gpt-image-1: low | medium | high | auto
    // gpt-image-1 always returns b64_json; response_format is not accepted.
  }
  return body;
}

async function generate(persona, outDir, version) {
  const v = String(version).padStart(3, '0');
  console.log(`  generating ${persona.id} v${v} …`);
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(requestBody(persona.prompt)),
  });
  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  const d = data.data[0];
  let buf;
  if (d.b64_json) buf = Buffer.from(d.b64_json, 'base64');
  else if (d.url) buf = Buffer.from(await (await fetch(d.url)).arrayBuffer());
  else throw new Error('unexpected response: no b64_json or url');

  const file = path.join(outDir, `${persona.id}-${v}.png`);
  fs.writeFileSync(file, buf);
  console.log(`  ✓ ${path.relative(process.cwd(), file)}`);
  if (d.revised_prompt) console.log(`    ↳ revised: ${clip(d.revised_prompt, 90)}`);
  return file;
}

// --- main ------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { count: 1, out: null, dryRun: false, profiles: [] };
  for (const a of argv) {
    if (a === '--dry-run') opts.dryRun = true;
    else if (a.startsWith('--count=')) opts.count = parseInt(a.split('=')[1], 10);
    else if (a.startsWith('--out=')) opts.out = a.split('=')[1];
    else if (a.startsWith('--appearance=')) opts.appearance = a.slice('--appearance='.length);
    else if (a.startsWith('--prompt-file=')) opts.promptFile = a.slice('--prompt-file='.length);
    else if (a.startsWith('--prompt=')) opts.prompt = a.slice('--prompt='.length);
    else if (a.startsWith('--')) { console.error(`unknown option: ${a}`); process.exit(1); }
    else opts.profiles.push(a);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.profiles.length) {
    console.error('usage: node lib/generate-team-avatars.mjs <agent.md> [...] [--count=N] [--out=DIR] [--dry-run]');
    process.exit(1);
  }
  if (!Number.isInteger(opts.count) || opts.count < 1 || opts.count > 5) {
    console.error('--count must be an integer 1-5');
    process.exit(1);
  }

  const outDir = path.resolve(opts.out || path.join(REPO_ROOT, 'tmp'));

  // A verbatim prompt (from --prompt-file or --prompt) overrides the
  // profile-derived prompt entirely — use it for hand-authored / external prompts.
  const rawPrompt = opts.promptFile
    ? fs.readFileSync(opts.promptFile, 'utf8').trim()
    : (opts.prompt || null);

  // Build personas from profiles (profile still supplies the output id/name).
  const personas = opts.profiles.map((p) => {
    const md = fs.readFileSync(p, 'utf8');
    const fallbackId = path.basename(p, '.md');
    const persona = extractPersona(md, fallbackId);
    return { ...persona, prompt: rawPrompt || buildPrompt(persona, opts.appearance) };
  });

  if (opts.dryRun) {
    for (const p of personas) {
      console.log(`\n──────── ${p.id} ────────\n${p.prompt}\n`);
    }
    console.log(`(dry run — ${personas.length} profile(s), would generate ${opts.count} each; model ${MODEL})`);
    return;
  }

  if (!OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is not set (add it to .env at the repo root).');
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const total = personas.length * opts.count;
  console.log(`engsys team avatars — model ${MODEL}, ${opts.count} variation(s) × ${personas.length} profile(s) = ${total} image(s)`);
  console.log(`output: ${outDir}\n`);

  let ok = 0, fail = 0;
  for (const persona of personas) {
    for (let i = 0; i < opts.count; i++) {
      const version = nextVersion(outDir, persona.id);
      try {
        await generate(persona, outDir, version);
        ok++;
        if (ok + fail < total) await new Promise((r) => setTimeout(r, 1500));
      } catch (e) {
        console.error(`  ✗ ${persona.id}: ${e.message}`);
        fail++;
      }
    }
  }

  console.log(`\ndone — ${ok}/${total} generated${fail ? `, ${fail} failed` : ''}.`);
  console.log('Pick a winner, then move it to team-images/<id>.png.');
}

main().catch((e) => { console.error(e); process.exit(1); });
