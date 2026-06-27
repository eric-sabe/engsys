'use strict';

// Minimal YAML-subset parser — zero dependencies, deliberately small.
// Supports exactly what engsys.config.yaml needs:
//   - nested maps (indentation based)
//   - scalars: strings (optionally quoted), true/false, null/~
//   - inline flow lists:  key: [a, b, c]
//   - block lists:        key:\n  - a\n  - b   (items indented under the key)
//   - block lists of maps: key:\n  - glob: x\n    reminder: y
//   - full-line (#...) and trailing ( #...) comments outside quotes
// It is NOT a general YAML implementation. Block sequences MUST be indented
// under their key. If you need richer config, switch the loader to js-yaml.

function stripTrailingComment(s) {
  let inS = false, inD = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '#' && !inS && !inD && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i);
    }
  }
  return s;
}

// Split on top-level commas only — respects [] {} nesting and quotes.
function splitTopLevel(s) {
  const parts = [];
  let depth = 0, inS = false, inD = false, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    if (!inS && !inD) {
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth--;
      else if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    }
    cur += c;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts;
}

function parseScalar(v) {
  v = v.trim();
  if (v === '') return '';
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (inner === '') return [];
    return splitTopLevel(inner).map((x) => parseScalar(x.trim()));
  }
  if (v.startsWith('{') && v.endsWith('}')) {
    const inner = v.slice(1, -1).trim();
    const obj = {};
    if (inner === '') return obj;
    for (const pair of splitTopLevel(inner)) {
      const ci = pair.indexOf(':');
      if (ci === -1) continue;
      obj[pair.slice(0, ci).trim()] = parseScalar(pair.slice(ci + 1).trim());
    }
    return obj;
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  return v;
}

function parseYaml(text) {
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*$/.test(raw)) continue;       // blank
    if (/^\s*#/.test(raw)) continue;       // full-line comment
    lines.push(raw);
  }
  if (lines.length === 0) return {};

  const indentOf = (line) => line.match(/^ */)[0].length;
  let idx = 0;

  function parseNode(blockIndent) {
    const first = lines[idx];
    const isList = /^\s*-(\s|$)/.test(first);

    if (isList) {
      const arr = [];
      while (idx < lines.length) {
        const line = lines[idx];
        const li = indentOf(line);
        if (li < blockIndent || !/^\s*-(\s|$)/.test(line)) break;
        if (li > blockIndent) break;
        // Column where the item's content begins (after "- " / "-\t" etc.).
        const dashSpan = line.slice(li).match(/^-\s*/)[0].length;
        const contentCol = li + dashSpan;
        const content = stripTrailingComment(line.slice(contentCol)).trim();
        if (content === '') {
          // nested block belongs to this item
          idx++;
          if (idx < lines.length && indentOf(lines[idx]) > blockIndent) {
            arr.push(parseNode(indentOf(lines[idx])));
          } else {
            arr.push(null);
          }
        } else if (/^[\w.-]+\s*:(\s|$)/.test(content)) {
          // map item: blank out the "- " so the first key keeps its original
          // column, then parse a map block starting at that column. Sibling keys
          // (indented to the same column) get folded into the same map.
          lines[idx] = line.slice(0, li) + ' '.repeat(dashSpan) + line.slice(contentCol);
          arr.push(parseNode(contentCol));
        } else {
          arr.push(parseScalar(content));
          idx++;
        }
      }
      return arr;
    }

    const obj = {};
    while (idx < lines.length) {
      const line = lines[idx];
      const li = indentOf(line);
      if (li < blockIndent) break;
      if (li > blockIndent) break; // malformed; stop this block
      const content = stripTrailingComment(line).trim();
      const m = content.match(/^([\w.-]+)\s*:\s*(.*)$/);
      if (!m) break;
      const key = m[1];
      const val = m[2];
      if (val === '') {
        idx++;
        if (idx < lines.length && indentOf(lines[idx]) > blockIndent) {
          obj[key] = parseNode(indentOf(lines[idx]));
        } else if (idx < lines.length && /^\s*-(\s|$)/.test(lines[idx] || '') &&
                   indentOf(lines[idx]) === blockIndent) {
          obj[key] = parseNode(blockIndent); // block list at same indent as key
        } else {
          obj[key] = null;
        }
      } else {
        obj[key] = parseScalar(val);
        idx++;
      }
    }
    return obj;
  }

  return parseNode(indentOf(lines[0]));
}

module.exports = { parseYaml };
