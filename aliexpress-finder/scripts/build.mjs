#!/usr/bin/env node
/* Build the compact install copies of the three browser files.
 *
 *   node scripts/build.mjs           # writes dist/<name>.min.js
 *   node scripts/build.mjs --check   # exit 1 if any dist copy is stale
 *
 * WHY (measured 2026-10-17): installing harvest.js means passing the whole
 * file as the `text` of one javascript_tool call. It was 31 KB, more than
 * half of it comments, and held raw invisible bidi characters on line 90.
 * In the wired-mouse run the operator hand-retyped a reduced copy instead,
 * and nothing tested that copy. The dist copy is the same code with the
 * comments and indentation removed, generated, never edited. test.mjs checks
 * that every dist copy equals a fresh build of its source and runs the
 * harvest scenarios against dist/harvest.min.js as well, so a stale or
 * broken copy fails the suite.
 *
 * The stripper is a small tokenizer, not a regex: it tracks strings,
 * template literals, regex literals and both comment forms, so "https://"
 * in a string and a slash-star inside a regex literal survive.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SOURCES = ['harvest.js', 'listing.js', 'extract.js'];

/* A "/" starts a regex literal after these characters or keywords, and is a
 * division after anything else. */
const REGEX_AFTER_CHAR = /[(,=:[!&|?{};+\-*%<>~^]/;
const REGEX_AFTER_WORD = /\b(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

// Line terminators JS knows besides \n (U+2028, U+2029, CR), built at
// run time so this file holds no raw invisible character.
const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029), CR = String.fromCharCode(13);
const isEol = (ch) => ch === '\n' || ch === CR || ch === LS || ch === PS;

export function strip(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  const stack = []; // template-literal nesting: '`' or '{'
  /* "if (u) /re/.test(u)": a "/" after the ")" of if/while/for/with starts a
   * regex, after any other ")" it is a division. Reading every ")" as a
   * division cut such a regex short at its "//" (review of the fix,
   * 2026-10-18). */
  const parens = []; // per open "(": did a control keyword come before it?
  const ctrlClose = new Set(); // out-indexes of ")" that close one of those
  const lastSig = () => {
    for (let k = out.length - 1; k >= 0; k--) if (!/\s/.test(out[k])) return k;
    return -1;
  };
  const regexAllowed = () => {
    const k = lastSig();
    if (k < 0) return true;
    const c = out[k];
    if (c === ')') return ctrlClose.has(k);
    // "i++ / 2" and "i-- / 2" divide; a lone "+" or "-" starts an operand.
    if ((c === '+' || c === '-') && out[k - 1] === c) return false;
    if (REGEX_AFTER_CHAR.test(c)) return true;
    if (/[\w$]/.test(c)) {
      const tail = out.slice(Math.max(0, k - 12), k + 1);
      const m = tail.match(REGEX_AFTER_WORD);
      // "o.return / 2" is a property, not the keyword.
      return !!m && out[k - m[0].length] !== '.';
    }
    return false;
  };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { // line comment
      while (i < n && !isEol(src[i])) i++;
      continue;
    }
    if (c === '/' && d === '*') { // block comment: keep one newline if it spanned lines
      const end = src.indexOf('*/', i + 2);
      const body = src.slice(i, end < 0 ? n : end + 2);
      i = end < 0 ? n : end + 2;
      out += [...body].some(isEol) ? '\n' : ' ';
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') {
          // A line continuation would lose the next line's indent to the trim below.
          if (src[j + 1] === '\n' || src[j + 1] === '\r') throw new Error('a string literal continues over a line; strip() would change it');
          j += 2; continue;
        }
        if (src[j] === '\n') break;
        j++;
      }
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '(') { parens.push(/\b(if|while|for|with)\s*$/.test(out)); out += c; i++; continue; }
    if (c === ')') { if (parens.pop()) ctrlClose.add(out.length); out += c; i++; continue; }
    if (c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') break;
        // The trim below would change a template's text across lines.
        if (isEol(src[j])) throw new Error('a template literal spans lines; strip() would change it');
        j++;
      }
      if (src[j] === '`') { out += src.slice(i, j + 1); i = j + 1; continue; }
      out += src.slice(i, j + 2); i = j + 2; stack.push('`'); continue;
    }
    if (c === '}' && stack.length && stack[stack.length - 1] === '`') {
      // back inside the template literal
      stack.pop();
      let j = i + 1;
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') break;
        // The trim below would change a template's text across lines.
        if (isEol(src[j])) throw new Error('a template literal spans lines; strip() would change it');
        j++;
      }
      if (src[j] === '`') { out += src.slice(i, j + 1); i = j + 1; continue; }
      out += src.slice(i, j + 2); i = j + 2; stack.push('`'); continue;
    }
    if (c === '{' && stack.length) { stack.push('{'); out += c; i++; continue; }
    if (c === '}' && stack.length && stack[stack.length - 1] === '{') { stack.pop(); out += c; i++; continue; }
    if (c === '/' && regexAllowed()) {
      let j = i + 1, cls = false;
      while (j < n) {
        const x = src[j];
        if (x === '\\') { j += 2; continue; }
        if (x === '\n') break;
        if (cls) { if (x === ']') cls = false; }
        else if (x === '[') cls = true;
        else if (x === '/') break;
        j++;
      }
      j++;
      while (j < n && /[a-z]/i.test(src[j])) j++; // flags
      out += src.slice(i, j); i = j; continue;
    }
    out += c; i++;
  }
  // Drop indentation, trailing blanks and empty lines. Safe here: no template
  // literal in these files spans lines (asserted below).
  return out.split('\n').map((l) => l.trim()).filter(Boolean).join('\n') + '\n';
}

export function build(name) {
  return buildSource(name, readFileSync(join(HERE, name), 'utf8'));
}

export function buildSource(name, src) {
  if (/`[^`]*\n[^`]*`/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, ''))) {
    throw new Error(name + ': a template literal spans lines; strip() would change it');
  }
  const out = strip(src);
  // The copy must still parse; a stripper slip must never reach the paste.
  try { new Function(out); } catch (e) { throw new Error(name + ': the stripped copy does not parse: ' + e.message); }
  /* And it must be the SAME program: parsing is not enough, a slip can
   * drop code that still parses ("i++ / 2, s = '/*'" lost a statement in a
   * review probe, 2026-10-18). Node's own acorn parses both, and the trees
   * must match, positions and comments aside. */
  const same = sameProgram(src, out);
  if (same === false) throw new Error(name + ': the stripped copy is not the same program as the source');
  return out;
}

/** true / false, or null when node's internal parser is not available. */
export function sameProgram(a, b) {
  const code = `
    const acorn = require('internal/deps/acorn/acorn/dist/acorn');
    const fs = require('fs');
    const [a, b] = JSON.parse(fs.readFileSync(0, 'utf8'));
    const tree = (s) => JSON.stringify(acorn.parse(s, { ecmaVersion: 'latest', allowReturnOutsideFunction: true }),
      (k, v) => (k === 'start' || k === 'end' ? undefined : v));
    process.stdout.write(tree(a) === tree(b) ? 'same' : 'differ');`;
  const r = spawnSync(process.execPath, ['--expose-internals', '-e', code], { input: JSON.stringify([a, b]), encoding: 'utf8',
    maxBuffer: 1 << 28 });
  if (r.status !== 0) return null;
  return r.stdout === 'same';
}

const isMain = process.argv[1] && /build\.mjs$/.test(process.argv[1]);
if (isMain) {
  const check = process.argv.includes('--check');
  const dist = join(HERE, 'dist');
  mkdirSync(dist, { recursive: true });
  let stale = 0;
  for (const name of SOURCES) {
    const min = build(name);
    const target = join(dist, name.replace(/\.js$/, '.min.js'));
    let cur = null;
    try { cur = readFileSync(target, 'utf8'); } catch (e) { /* missing */ }
    if (check) {
      if (cur !== min) { stale++; console.log('STALE ' + target); }
      else console.log('ok    ' + target + ' (' + min.length + ' chars)');
    } else {
      writeFileSync(target, min);
      console.log('wrote ' + target + ' (' + min.length + ' of ' + readFileSync(join(HERE, name), 'utf8').length + ' chars)');
    }
  }
  if (check && stale) process.exit(1);
}
