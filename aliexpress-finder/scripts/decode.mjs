#!/usr/bin/env node
/* Reassemble a harvest payload from whatever channel it came back through.
 *
 *   node decode.mjs <file...> > harvest.json
 *   node decode.mjs --check <file...>        # print coverage, no payload
 *
 * Three input shapes are accepted, mixed freely, in any order:
 *
 *  1. IN-APP BROWSER, oversized result saved by the harness. A JSON array of
 *     {type, text}; one text is a JSON STRING whose content is the payload
 *     JSON (double-encoded). Detected by "harvest-paged" inside it.
 *
 *  2. CHROME CONNECTOR, get_page_text dumps. The javascript_tool there cuts
 *     every result at 1,000 characters (measured 2026-09-14), so
 *     __aeHarvest.expose(i) writes chunk i into the page and get_page_text
 *     reads it back. Each dump holds one chunk between
 *       "AEPAYLOAD <i>/<n> START" and "AEPAYLOAD END".
 *     Chunks are ordered by <i>; a missing one is an error, not a guess.
 *     A dump may be a raw text file or a harness-saved JSON array.
 *
 *  3. A plain payload JSON file (already decoded). Passed through.
 *
 * Output is the payload JSON, parsed and re-serialised, so a truncated or
 * half-pasted input fails loudly instead of feeding rank.mjs a fragment.
 */
import { readFileSync } from 'node:fs';

const CHUNK_RE = /AEPAYLOAD (\d+)\/(\d+) START\n([\s\S]*?)\nAEPAYLOAD END/g;

/** Every text fragment an input file can carry, flattened. */
export function textsOf(raw) {
  const s = String(raw);
  try {
    const j = JSON.parse(s);
    if (Array.isArray(j)) return j.map((x) => (x && typeof x.text === 'string' ? x.text : '')).filter(Boolean);
    if (j && typeof j === 'object') return [s];
  } catch (e) { /* not JSON: a raw page-text dump */ }
  return [s];
}

/** Shape 1: the double-encoded in-app file. Returns the payload object or null. */
export function fromInAppFile(texts) {
  for (const t of texts) {
    if (!t.includes('harvest-paged')) continue;
    const first = t.indexOf('"');
    for (let end = t.lastIndexOf('"'); end > first; end = t.lastIndexOf('"', end - 1)) {
      try { return JSON.parse(JSON.parse(t.slice(first, end + 1))); } catch (e) { /* keep shrinking */ }
    }
  }
  return null;
}

/** Shape 2: chunk markers across any number of dumps. */
export function chunksOf(texts) {
  const found = new Map();
  let total = null;
  for (const t of texts) {
    let m;
    CHUNK_RE.lastIndex = 0;
    while ((m = CHUNK_RE.exec(t))) {
      const i = Number(m[1]); const n = Number(m[2]);
      if (total !== null && total !== n) throw new Error(`chunk count mismatch: ${total} vs ${n}`);
      total = n;
      found.set(i, m[3]);
    }
  }
  return { found, total };
}

export function assemble(texts) {
  const inApp = fromInAppFile(texts);
  if (inApp) return { payload: inApp, via: 'in-app-file' };

  const { found, total } = chunksOf(texts);
  if (total !== null) {
    const missing = [];
    for (let i = 0; i < total; i++) if (!found.has(i)) missing.push(i);
    if (missing.length) throw new Error(`missing chunk(s) ${missing.join(', ')} of ${total} — expose() and read them before decoding`);
    const joined = Array.from({ length: total }, (_, i) => found.get(i)).join('');
    return { payload: JSON.parse(joined), via: `page-text-chunks(${total})` };
  }

  for (const t of texts) {
    try {
      const j = JSON.parse(t);
      if (j && typeof j === 'object' && (Array.isArray(j.items) || j.source)) return { payload: j, via: 'plain-json' };
    } catch (e) { /* next */ }
  }
  throw new Error('no payload found: expected an in-app saved result, AEPAYLOAD chunks, or a payload JSON');
}

const isMain = process.argv[1] && /decode\.mjs$/.test(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const files = args.filter((a) => a !== '--check');
  if (!files.length) { console.error('usage: node decode.mjs [--check] <file...>'); process.exit(2); }
  const texts = files.flatMap((f) => textsOf(readFileSync(f, 'utf8')));
  let res;
  try { res = assemble(texts); } catch (e) { console.error('decode: ' + e.message); process.exit(1); }
  const p = res.payload;
  const summary = { via: res.via, query: p.query, coverage: p.coverage, cardCount: p.cardCount, withRating: p.withRating,
    blocked: p.blocked, suspectedWall: p.suspectedWall };
  if (check) { console.log(JSON.stringify(summary, null, 1)); }
  else { process.stdout.write(JSON.stringify(p)); console.error(JSON.stringify(summary)); }
}
