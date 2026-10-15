import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CORE_AGENTS_DIR = path.join(ROOT, 'core/agents');
const OPTIONAL_AGENTS_DIR = path.join(ROOT, 'optional-agents');
const CORE_SKILLS_DIR = path.join(ROOT, 'core/skills');
const STACKS_DIR = path.join(ROOT, 'stacks');

function listMarkdownFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listMarkdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results.sort();
}

function parseFrontmatter(content) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(content);
  if (!match) return { frontmatter: null, body: content };
  const fm = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const rawVal = line.slice(idx + 1).trim();
    if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
      const inner = rawVal.slice(1, -1).trim();
      fm[key] = inner ? inner.split(',').map((s) => s.trim()) : [];
    } else if (key === 'tools' || key === 'skills') {
      fm[key] = rawVal ? rawVal.split(',').map((s) => s.trim()) : [];
    } else {
      fm[key] = rawVal.replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return { frontmatter: fm, body: match[2] };
}

function collectAllSkillNames() {
  const names = new Set();
  for (const entry of fs.readdirSync(CORE_SKILLS_DIR, { withFileTypes: true })) {
    if (entry.isDirectory() && fs.existsSync(path.join(CORE_SKILLS_DIR, entry.name, 'SKILL.md'))) {
      names.add(entry.name);
    }
  }
  for (const file of listMarkdownFiles(STACKS_DIR)) {
    if (path.basename(file) === 'SKILL.md') {
      names.add(path.basename(path.dirname(file)));
    }
  }
  return names;
}

describe('Personas & Skills Contract Suite (CT-PS-01..CT-PS-09)', () => {
  const personaFiles = [
    ...listMarkdownFiles(CORE_AGENTS_DIR),
    ...listMarkdownFiles(OPTIONAL_AGENTS_DIR),
  ];

  test('CT-PS-01: All 15 persona files define frontmatter (name, description, model, tools, skills), least-privilege tools, and Handback Protocol', () => {
    assert.equal(personaFiles.length, 15, 'Expected exactly 15 persona markdown files');
    const allSkills = collectAllSkillNames();
    const readOnlyCritics = new Set([
      'gary',
      'melvin',
      'nyx',
      'leith',
      'marcelo',
      'otto',
      'jos',
      'sandy',
      'deandre',
      'steve',
    ]);

    for (const file of personaFiles) {
      const stem = path.basename(file, '.md');
      const content = fs.readFileSync(file, 'utf8');
      const { frontmatter, body } = parseFrontmatter(content);

      assert.ok(frontmatter, `${file} is missing YAML frontmatter`);
      assert.equal(frontmatter.name, stem, `${file} frontmatter name must match filename stem`);
      assert.ok(frontmatter.description && frontmatter.description.length > 10, `${file} must have a non-empty description`);
      assert.ok(frontmatter.model, `${file} must define model`);
      assert.ok(Array.isArray(frontmatter.tools) && frontmatter.tools.length > 0, `${file} must define tools allowlist`);
      assert.ok(Array.isArray(frontmatter.skills), `${file} must define skills array`);

      for (const skill of frontmatter.skills) {
        assert.ok(allSkills.has(skill), `${file} binds nonexistent skill '${skill}'`);
      }

      if (readOnlyCritics.has(stem)) {
        assert.ok(
          !frontmatter.tools.includes('Bash') && !frontmatter.tools.includes('Edit'),
          `NA-PS-1 violation: Read-only critic ${stem} must not list Bash or Edit in tools (${frontmatter.tools.join(', ')})`
        );
      }

      if (stem === 'steve') {
        assert.equal(frontmatter.model, 'haiku', 'steve.md must use model: haiku');
        assert.deepEqual(frontmatter.tools, ['Read'], 'steve.md must only have Read tool');
      }

      if (stem === 'nyx') {
        assert.match(frontmatter.model, /^claude-opus-/, 'nyx.md must pin full security model ID');
        assert.equal(frontmatter.security, 'true', 'nyx.md must keep security: true');
      }

      assert.match(body, /## Handback Protocol/, `${file} must include ## Handback Protocol`);
      assert.match(body, /STATUS: COMPLETE/, `${file} must document STATUS: COMPLETE`);
      assert.match(body, /STATUS: INCOMPLETE/, `${file} must document STATUS: INCOMPLETE`);
    }
  });

  test('CT-PS-02: Isabelle, Jody, Bert, Otto, Marcelo, Nyx, Aaron, and Patricia carry 2026 SDD & fleet wiring', () => {
    const isabelle = fs.readFileSync(path.join(CORE_AGENTS_DIR, 'isabelle.md'), 'utf8');
    assert.match(isabelle, /origin\/main/, 'isabelle.md must branch worktrees from origin/main');
    assert.match(isabelle, /Co-commit exception|co-commit/i, 'isabelle.md must document file-overlap co-commit rule');
    assert.match(isabelle, /claim\.mjs release/, 'isabelle.md must document claim.mjs release');
    assert.match(isabelle, /mm:ready/, 'isabelle.md must document mm:ready handoff');
    assert.match(isabelle, /spec-slice\.mjs/, 'isabelle.md must reference spec-slice.mjs');
    assert.match(isabelle, /contract-check\.mjs/, 'isabelle.md must reference contract-check.mjs');

    const jody = fs.readFileSync(path.join(CORE_AGENTS_DIR, 'jody.md'), 'utf8');
    assert.match(jody, /<!-- engsys:issue-meta/, 'jody.md must require <!-- engsys:issue-meta -->');
    assert.match(jody, /Part of \[.*\] · spec:/, 'jody.md must require Part of [...] · spec: context line');
    assert.match(jody, /issue-tracker-/, 'jody.md must reference issue-tracker-* abstraction');
    assert.match(jody, /📄 Content:/, 'jody.md must include 📄 Content: title format');

    const bert = fs.readFileSync(path.join(CORE_AGENTS_DIR, 'bert.md'), 'utf8');
    assert.match(bert, /<!-- engsys:issue-meta/, 'bert.md must require <!-- engsys:issue-meta -->');
    assert.match(bert, /issue-tracker-/, 'bert.md must reference issue-tracker-* abstraction');
    assert.match(bert, /📄 Content:/, 'bert.md must use 📄 Content: emoji');

    const otto = fs.readFileSync(path.join(CORE_AGENTS_DIR, 'otto.md'), 'utf8');
    assert.match(otto, /llm-structured-outputs/, 'otto.md must reference llm-structured-outputs');
    assert.match(otto, /agentic-eval/, 'otto.md must reference agentic-eval');
    assert.doesNotMatch(otto, /claude-api/, 'otto.md must not reference nonexistent claude-api skill');

    const marcelo = fs.readFileSync(path.join(CORE_AGENTS_DIR, 'marcelo.md'), 'utf8');
    assert.ok(marcelo.split('\n').length <= 150, `marcelo.md should be <= 150 lines (got ${marcelo.split('\n').length})`);
    assert.doesNotMatch(marcelo, /docs\/\{sprint\}\/testing-strategy\.md/, 'marcelo.md must not use legacy sprint path');
    assert.doesNotMatch(marcelo, /"Honey,/, 'marcelo.md must not contain copy-pasted Honey typo');
    assert.match(marcelo, /Contract Test Table/i, 'marcelo.md must require Contract Test Table');

    const nyx = fs.readFileSync(path.join(CORE_AGENTS_DIR, 'nyx.md'), 'utf8');
    assert.match(nyx, /untrusted_input/, 'nyx.md must cover <untrusted_input> boundary security');
    assert.match(nyx, /Negative Security Assertions/i, 'nyx.md must require Negative Security Assertions (NA-*)');
  });

  test('CT-PS-03: Zero $(cat << subshell HEREDOC patterns across all skills and personas (NA-PS-2)', () => {
    const allMd = [
      ...personaFiles,
      ...listMarkdownFiles(CORE_SKILLS_DIR),
      ...listMarkdownFiles(STACKS_DIR),
    ];
    for (const file of allMd) {
      const content = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(
        content,
        /\$\(cat <</,
        `NA-PS-2 violation: ${path.relative(ROOT, file)} contains $(cat << subshell HEREDOC`
      );
    }
  });

  test('CT-PS-04: Zero mcp__github__ fallback recommendations across all skills and personas (NA-PS-3)', () => {
    const allMd = [
      ...personaFiles,
      ...listMarkdownFiles(CORE_SKILLS_DIR),
      ...listMarkdownFiles(STACKS_DIR),
    ];
    for (const file of allMd) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        if (line.includes('mcp__github__')) {
          assert.match(
            line,
            /never|no GitHub MCP|prohibit|ban|Don't|do not/i,
            `NA-PS-3 violation at ${path.relative(ROOT, file)}:${idx + 1}: ${line}`
          );
        }
      });
    }
  });

  test('CT-PS-05: Zero nonexistent skill references or broken reference links across personas, core/skills, core/commands, and stacks/', () => {
    const forbiddenSkillPatterns = [
      /\bclaude-api\b/,
      /\brepo-rebuilder\b/,
      /\bdesign-review\b(?!er)/,
      /\bswiftui-navigation\b/,
      /\bswiftui-layout-components\b/,
      /\bswiftui-animation\b/,
      /\bsosumi\.ai\b/,
      /\bgithub-issues\b/,
      /\bterraform-conventions\b/,
    ];
    const filesToCheck = [
      ...personaFiles,
      ...listMarkdownFiles(CORE_SKILLS_DIR),
      ...listMarkdownFiles(path.join(ROOT, 'core/commands')),
      ...listMarkdownFiles(STACKS_DIR),
    ];
    for (const file of filesToCheck) {
      const content = fs.readFileSync(file, 'utf8');
      for (const bad of forbiddenSkillPatterns) {
        assert.doesNotMatch(
          content,
          bad,
          `${path.relative(ROOT, file)} references nonexistent skill or URL matching ${bad}`
        );
      }
      if (file.endsWith('design-critique.md') || file.endsWith('design-audit.md')) {
        assert.match(content, /web-design-reviewer/, `${path.basename(file)} must reference web-design-reviewer`);
        assert.doesNotMatch(content, /Use the \*\*`design-critique`\*\* skill/, `${path.basename(file)} must not reference design-critique skill`);
      }
    }
  });

  test('CT-PS-06: Progressive disclosure line budgets on core/skills/*/SKILL.md', () => {
    const budgets = {
      'gh-cli': 140,
      'merge-monster': 200,
      'maintenance-monster': 200,
      'refactor': 140,
      'git-workflow-agents': 160,
    };
    for (const [skill, maxLines] of Object.entries(budgets)) {
      const skillFile = path.join(CORE_SKILLS_DIR, skill, 'SKILL.md');
      const lineCount = fs.readFileSync(skillFile, 'utf8').split('\n').length;
      assert.ok(
        lineCount <= maxLines,
        `${skill}/SKILL.md exceeds line budget: ${lineCount} > ${maxLines}`
      );
    }
    assert.ok(!fs.existsSync(path.join(CORE_SKILLS_DIR, 'git-commit')), 'git-commit must be retired');
    assert.ok(!fs.existsSync(path.join(CORE_SKILLS_DIR, 'github-issues')), 'github-issues must be retired');
    assert.ok(!fs.existsSync(path.join(STACKS_DIR, 'iac/terraform/skills/terraform-conventions')), 'terraform-conventions must be retired');
  });

  test('CT-PS-07: Zero Keystone monorepo leakage across stacks/**/*.md', () => {
    const forbiddenLeakage = [
      /@keystone\//,
      /feedfrwd/i,
      /backend-api/,
      /apps\/web\/Dockerfile/,
      /packages\/database\/generated\/prisma/,
      /app\.feedfrwd\.com/,
      /keystone-prod/,
      /keystone-staging/,
    ];
    for (const file of listMarkdownFiles(STACKS_DIR)) {
      const content = fs.readFileSync(file, 'utf8');
      for (const pattern of forbiddenLeakage) {
        assert.doesNotMatch(
          content,
          pattern,
          `Monorepo leakage in ${path.relative(ROOT, file)} matching ${pattern}`
        );
      }
    }
  });

  test('CT-PS-08: All 24 stack packs have claude.fragment.md, list their skills, and pass build-plugins.mjs --check', () => {
    let packCount = 0;
    for (const cat of fs.readdirSync(STACKS_DIR).sort()) {
      const catDir = path.join(STACKS_DIR, cat);
      if (!fs.statSync(catDir).isDirectory()) continue;
      for (const val of fs.readdirSync(catDir).sort()) {
        const packDir = path.join(catDir, val);
        if (!fs.statSync(packDir).isDirectory()) continue;
        packCount++;
        const fragPath = path.join(packDir, 'claude.fragment.md');
        assert.ok(fs.existsSync(fragPath), `Missing claude.fragment.md in stacks/${cat}/${val}`);
        const fragContent = fs.readFileSync(fragPath, 'utf8');
        const skillsDir = path.join(packDir, 'skills');
        if (fs.existsSync(skillsDir)) {
          for (const skillEntry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
            if (skillEntry.isDirectory() && fs.existsSync(path.join(skillsDir, skillEntry.name, 'SKILL.md'))) {
              assert.ok(
                fragContent.includes(skillEntry.name),
                `stacks/${cat}/${val}/claude.fragment.md must reference its skill '${skillEntry.name}'`
              );
            }
          }
        }
      }
    }
    assert.equal(packCount, 24, `Expected 24 stack packs, found ${packCount}`);

    execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-plugins.mjs'), '--check'], {
      cwd: ROOT,
      stdio: 'pipe',
    });
  });

  test('CT-PS-09: llm-structured-outputs includes October 2026 model catalog and output_config.format', () => {
    const skillMd = fs.readFileSync(path.join(CORE_SKILLS_DIR, 'llm-structured-outputs/SKILL.md'), 'utf8');
    const providerDetails = fs.readFileSync(
      path.join(CORE_SKILLS_DIR, 'llm-structured-outputs/references/provider-details.md'),
      'utf8'
    );
    for (const modelId of ['claude-sonnet-5', 'claude-opus-4-8', 'gpt-5.6-terra', 'deepseek-v4-pro', 'grok-4.5']) {
      assert.ok(skillMd.includes(modelId), `llm-structured-outputs/SKILL.md missing ${modelId}`);
      assert.ok(providerDetails.includes(modelId), `provider-details.md missing ${modelId}`);
    }
    assert.match(skillMd, /output_config:\s*\{\s*format:/);
    assert.doesNotMatch(skillMd, /output_format:\s*zodOutputFormat/);
    assert.doesNotMatch(providerDetails, /output_format:\s*zodOutputFormat/);
  });

  test('CT-PS-10: Conditional skill manifest pruning (RETIRED_CORE_SKILLS and includeGhCli on issue_tracker: linear)', async () => {
    const manifestMod = await import(path.join(ROOT, 'lib/manifest.js'));
    const { buildManifest, RETIRED_CORE_SKILLS, includeGhCli } = manifestMod.default || manifestMod;
    assert.deepEqual([...RETIRED_CORE_SKILLS], ['git-commit', 'github-issues', 'terraform-conventions']);
    assert.equal(includeGhCli({ issue_tracker: 'linear', stacks: ['tooling/linear'] }), false);
    assert.equal(includeGhCli({ issue_tracker: 'linear', stacks: ['tooling/linear', 'tooling/github'] }), true);

    const plan = buildManifest(ROOT, { issue_tracker: 'linear', stacks: ['tooling/linear'] });
    const skillNames = plan.skillDirs.map((s) => s.name);
    for (const retired of RETIRED_CORE_SKILLS) {
      assert.ok(!skillNames.includes(retired), `Retired skill '${retired}' must be absent from manifest`);
    }
    assert.ok(!skillNames.includes('gh-cli'), 'gh-cli must be omitted when issue_tracker is linear without github pack');
    assert.ok(skillNames.includes('issue-tracker-linear'), 'issue-tracker-linear must be present');
  });
});


