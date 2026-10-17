// rule-units.mjs — split a SKILL.md into normalized rule units (sentences that state a rule).
//
// Used by monster-skill-rules.test.mjs to diff a baseline SKILL.md against the current one. A unit
// is one sentence of prose, one list item's sentence, or one table row, with markdown emphasis and
// code marks removed. Only units that state an imperative or a rule are kept.

/** Markdown-insensitive comparison form: no emphasis/code marks, one space, straight quotes, lowercase. */
export function normalize(text) {
  return String(text)
    .replace(/[*`]/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\\\|/g, '|')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const RULE_WORD = /\b(never|always|must|only|once|do not|don't|not|no|exactly|stop|refuse[sd]?|before|after|until|unless|at most|at once|first|then|immediately|require[sd]?)\b|→/i;

/** Blocks: paragraphs and list items (continuation lines joined), table rows; code fences dropped. */
function blocks(markdown) {
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
  const out = [];
  let cur = [];
  let inFence = false;
  const flush = () => { if (cur.length) out.push(cur.join(' ')); cur = []; };
  for (const raw of body.split('\n')) {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) { flush(); inFence = !inFence; continue; }
    if (inFence) continue;
    if (/^\s*$/.test(line) || /^#{1,6} /.test(line)) { flush(); continue; }
    if (/^\s*\|/.test(line)) { flush(); if (!/^\s*\|[\s|:-]+\|\s*$/.test(line)) out.push(line); continue; }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) { flush(); cur.push(line.replace(/^\s*([-*]|\d+\.)\s+/, '')); continue; }
    if (/^\s*>/.test(line)) { flush(); cur.push(line.replace(/^\s*>\s?/, '')); continue; }
    cur.push(line.trim());
  }
  flush();
  return out;
}

/** Sentences of a block: split on ". " / "; " boundaries outside code spans and parentheses. */
function sentences(block) {
  const res = [];
  let depth = 0, code = false, start = 0;
  for (let i = 0; i < block.length; i++) {
    const c = block[i];
    if (c === '`') code = !code;
    else if (!code && c === '(') depth++;
    else if (!code && c === ')') depth = Math.max(0, depth - 1);
    else if (!code && depth === 0 && (c === '.' || c === ':' || c === '·') && block[i + 1] === ' ' && /[A-Z*`(]/.test(block[i + 2] || '')) {
      res.push(block.slice(start, i + 1)); start = i + 2;
    }
  }
  res.push(block.slice(start));
  return res.map((s) => s.trim()).filter(Boolean);
}

/** Every normalized sentence of a SKILL.md (before the rule filter), in document order. */
export function allSentences(markdown) {
  const out = [];
  for (const b of blocks(markdown)) for (const s of sentences(b)) out.push(normalize(s).replace(/[.:;]$/, ''));
  return out;
}

/** The normalized rule units of a SKILL.md, deduplicated, in document order. */
export function ruleUnits(markdown) {
  const seen = new Set();
  const units = [];
  for (const b of blocks(markdown)) {
    for (const s of sentences(b)) {
      const n = normalize(s).replace(/[.:;]$/, '');
      if (n.length < 12 || !RULE_WORD.test(n) || seen.has(n)) continue;
      seen.add(n);
      units.push(n);
    }
  }
  return units;
}
