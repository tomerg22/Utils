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
 *       "AEPAYLOAD <i>/<n> <id> START" and "AEPAYLOAD END".
 *     <id> names the payload (a hash of its text), so the chunks of two
 *     exports are two payloads, never mixed. Chunks are ordered by <i>; a
 *     missing one is an error, not a guess. Markers without an id (older
 *     harvest.js) form one group.
 *     A dump may be a raw text file or a harness-saved JSON array.
 *
 *  3. A plain payload JSON file (already decoded), or a JSON array of them.
 *
 * Output is the payload JSON, parsed and re-serialised, so a truncated or
 * half-pasted input fails loudly instead of feeding rank.mjs a fragment.
 *
 * SEVERAL PAYLOADS ARE MERGED, never dropped. Measured 2026-10-18: given
 * `decode.mjs a.json b.json`, the decoder returned a.json alone, with exit 0
 * and no warning, and the hidden-tab recovery ("merge the two saved
 * payloads") lost the second harvest that way. Now every payload found is
 * kept: items are deduped by id (the record with more data wins, as in
 * rank.mjs), and `parts` keeps each input's query, filters, pages and
 * coverage, so a merged file can be merged again with the same result.
 *
 * THE MERGED VERDICT is worked out per search STREAM (the query's slug,
 * fourStar and the extra filters as `filterKey`), because page numbers mean
 * nothing across streams. A stream is 'exhausted-all-results' only when a
 * part ran dry at page P, the pages read cover 1..P with no gap, and no part
 * read items past P (the stream changed between runs: 'truncated', with a
 * `stream-changed` warning). Every stream must be complete for the merge to
 * be. A part whose titles do not match its query is 'off-query' even when it
 * came from a harvest.js too old to say so. A stream counts as blocked only
 * when its LAST page read hit the wall.
 */
import { readFileSync } from 'node:fs';
import { queryRelevance } from './lib.mjs';

const CHUNK_RE = /AEPAYLOAD (\d+)\/(\d+)(?: ([0-9a-z]+))? START\n([\s\S]*?)\nAEPAYLOAD END/g;
const START_RE = /AEPAYLOAD \d+\/\d+(?: [0-9a-z]+)? START/g;
const CR = String.fromCharCode(13);

/** Every text fragment an input file can carry, flattened. */
export function textsOf(raw) {
  const s = String(raw);
  try {
    const j = JSON.parse(s);
    if (Array.isArray(j)) {
      // An array of payloads (what rank.mjs also accepts): one text each.
      if (j.length && j.every((x) => x && typeof x === 'object' && Array.isArray(x.items))) return j.map((x) => JSON.stringify(x));
      return j.map((x) => (x && typeof x.text === 'string' ? x.text : '')).filter(Boolean);
    }
    if (j && typeof j === 'object') return [s];
  } catch (e) { /* not JSON: a raw page-text dump */ }
  return [s];
}

/** Shape 1: the double-encoded in-app file. Returns the payload object or null. */
export function fromInAppFile(texts) {
  return fromInAppFiles(texts)[0] || null;
}

/** Every double-encoded in-app payload among the texts, in input order.
 * The JSON string is found by ONE scan to its closing quote. The old way
 * tried every closing quote from the end backwards, which took 12 s on a
 * cut 562K file and then said "no payload found" for a file that held one. */
export function fromInAppFiles(texts) {
  const out = [];
  for (const t of texts) {
    if (!t.includes('harvest-paged')) continue;
    if (/^\s*\{/.test(t)) continue; // a plain payload, not double-encoded
    if (/AEPAYLOAD \d+\/\d+/.test(t)) continue; // a chunk dump (its chunk text holds "harvest-paged" too)
    // The harness saves the result as a JSON string. Only a text that IS one
    // is judged here, so its errors can be named.
    const lead = /^\s*"/.test(t);
    const first = t.indexOf('"');
    if (first < 0) continue;
    let end = -1;
    for (let i = first + 1; i < t.length; i++) {
      if (t[i] === '\\') { i++; continue; }
      if (t[i] === '"') { end = i; break; }
    }
    if (end < 0) {
      if (!lead) continue;
      throw new Error('an in-app saved result holds "harvest-paged" but is cut: its JSON string never closes. ' +
        'Save the payload() result again, whole.');
    }
    let p;
    try { p = JSON.parse(JSON.parse(t.slice(first, end + 1))); } catch (e) {
      if (!lead) continue;
      throw new Error('an in-app saved result holds "harvest-paged" but its payload is not complete JSON (' +
        String(e.message).slice(0, 80) + '). Save the payload() result again, whole.');
    }
    if (p && typeof p === 'object') out.push(p);
  }
  return out;
}

const slugOf = (q) => String(q || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
/* The filterKey harvest.js writes, so an older payload without one (and
 * without extra) joins the same stream as a new one. */
const filterKeyOf = (fourStar, extra) => {
  let h = 5381;
  const t = (fourStar === false ? '0' : '4') + '|' + (extra || '');
  for (let k = 0; k < t.length; k++) h = ((h * 33) ^ t.charCodeAt(k)) >>> 0;
  return h.toString(36);
};

/** One input payload as a stream part: what the verdict needs, no items. */
function partOf(p, idx) {
  const verdict = (p.coverage && p.coverage.verdict) || null;
  const rel = p.query ? queryRelevance(p.query, (p.items || []).map((i) => i && i.title)) : { warning: null };
  return {
    query: p.query || null,
    fourStar: p.fourStar !== false,
    // An old payload with an unknown extra never joins another stream.
    filterKey: p.filterKey || (p.extraApplied ? 'unknown-extra-' + idx : filterKeyOf(p.fourStar, '')),
    source: p.source || null,
    coverage: p.coverage || null,
    streamVerdict: (p.coverage && (p.coverage.streamVerdict || p.coverage.verdict)) || null,
    offQuery: verdict === 'off-query' || !!rel.warning,
    pages: (Array.isArray(p.pages) ? p.pages : []).filter((pg) => pg && pg.page != null)
      .map((pg) => ({ page: Number(pg.page), n: pg.n == null ? null : Number(pg.n) })),
    blocked: p.blocked === true,
    suspectedWall: p.suspectedWall === true,
    cardCount: Array.isArray(p.items) ? p.items.length : 0,
    warnings: [...(Array.isArray(p.warnings) ? p.warnings : []), ...(rel.warning && verdict !== 'off-query' ? [rel.warning] : [])],
  };
}

/** The parts a payload stands for: a merged payload carries its own. */
function partsOf(p, idx) {
  if (p && p.source === 'merged' && Array.isArray(p.parts) && p.parts.length &&
      p.parts.every((x) => x && Array.isArray(x.pages) && 'filterKey' in x)) return p.parts;
  return [partOf(p, idx)];
}

/** Merge several payloads into one. See the header. */
export function mergePayloads(list) {
  if (list.length === 1) return list[0];
  const byId = new Map();
  const richness = (o) => (o.reviews ? 2 : 0) + (o.rating ? 1 : 0);
  for (const p of list) {
    for (const it of p.items || []) {
      const prev = byId.get(it.id);
      if (!prev || richness(it) > richness(prev)) byId.set(it.id, prev ? { ...prev, ...it } : it);
    }
  }
  const parts = list.flatMap((p, i) => partsOf(p, i));
  const keyOf = (x) => [slugOf(x.query), x.fourStar ? '4star' : 'all', x.filterKey].join('|');
  const streams = new Map();
  for (const x of parts) {
    const k = keyOf(x);
    if (!streams.has(k)) streams.set(k, []);
    streams.get(k).push(x);
  }
  const warnings = [];
  const warn = (w) => { if (!warnings.includes(w)) warnings.push(w); };
  for (const x of parts) for (const w of x.warnings || []) warn(w);
  const byQuery = [...streams.entries()].map(([key, ps]) => {
    const pages = new Map(); // page -> most items any part saw there
    for (const x of ps) for (const pg of x.pages) pages.set(pg.page, Math.max(pages.get(pg.page) ?? -1, pg.n ?? 0));
    const maxPage = pages.size ? Math.max(...pages.keys()) : 0;
    let contiguous = maxPage > 0;
    for (let i = 1; i <= maxPage; i++) if (!pages.has(i)) { contiguous = false; break; }
    // Where each dry part ran dry: its last page.
    const dry = ps.filter((x) => /^exhausted/.test(x.streamVerdict || '') && x.pages.length)
      .map((x) => { const last = x.pages.reduce((a, b) => (b.page > a.page ? b : a)); return { page: last.page, empty: !last.n }; });
    const dryPage = dry.length ? Math.min(...dry.map((d) => d.page)) : null;
    const dryEmpty = dry.some((d) => d.page === dryPage && d.empty);
    const changed = dryPage != null && [...pages.entries()].some(([pg, n]) => n > 0 && (pg > dryPage || (pg === dryPage && dryEmpty)));
    const off = ps.some((x) => x.offQuery);
    const q = ps[0].query || null;
    if (changed) {
      warn(`stream-changed: "${q}" ran dry at page ${dryPage} in one part, but another part read items at or past it. ` +
        'The stream changed between the runs, so the merge is NOT all results.');
    }
    // Blocked only when the last page of the stream hit the wall.
    const lastPart = ps.reduce((a, b) => (Math.max(0, ...b.pages.map((pg) => pg.page)) >= Math.max(0, ...a.pages.map((pg) => pg.page)) ? b : a));
    const verdict = off ? 'off-query' : dryPage != null && !changed && contiguous ? 'exhausted-all-results' : 'truncated';
    return { query: q, stream: key, pagesRead: [...pages.keys()].sort((a, b) => a - b), pagesContiguousFrom1: contiguous,
      verdict, blocked: verdict !== 'exhausted-all-results' && lastPart.blocked,
      suspectedWall: verdict !== 'exhausted-all-results' && lastPart.suspectedWall };
  });
  const slugs = [...new Set(parts.map((x) => slugOf(x.query)))];
  const queries = [...new Set(parts.map((x) => x.query).filter(Boolean))];
  if (slugs.length > 1) warn('merged-queries: the parts were harvested for different queries (' + queries.join(' | ') + ')');
  if (streams.size > slugs.length) {
    warn('merged-filters: parts of the same query used different filters (fourStar or extra), so they are ' +
      'different search streams; each is judged on its own pages (coverage.byQuery)');
  }
  if (parts.some((x) => x.blocked) && !byQuery.some((s) => s.blocked)) {
    warn('wall-cleared: a part stopped at a wall, and a later part read the rest of that stream');
  }
  const items = [...byId.values()];
  const offQuery = byQuery.some((x) => x.verdict === 'off-query');
  const allDone = byQuery.every((x) => x.verdict === 'exhausted-all-results');
  return {
    query: queries.join(' | ') || null,
    source: 'merged',
    blocked: byQuery.some((s) => s.blocked),
    suspectedWall: byQuery.some((s) => s.suspectedWall),
    coverage: {
      verdict: offQuery ? 'off-query' : allDone ? 'exhausted-all-results' : 'truncated',
      byQuery,
      pagesRead: byQuery.length === 1 ? byQuery[0].pagesRead : undefined,
      pagesContiguousFrom1: byQuery.length === 1 ? byQuery[0].pagesContiguousFrom1 : undefined,
      claimedTotalIsUnreliable: true,
    },
    parts,
    warnings,
    cardCount: items.length,
    withRating: items.filter((i) => i.rating != null).length,
    items,
  };
}

/** Shape 2: chunk markers across any number of dumps, grouped by payload id.
 * Returns [{ id, total, found: Map(index -> text) }]. Line ends are made LF
 * first. A START marker with no matching END is an error, never a skip: a
 * dump saved with CRLF, or cut, used to vanish without a word. */
export function chunkGroups(texts) {
  const groups = new Map();
  for (const raw of texts) {
    const t = String(raw).split(CR + '\n').join('\n');
    const starts = (t.match(START_RE) || []).length;
    let matched = 0;
    let m;
    CHUNK_RE.lastIndex = 0;
    while ((m = CHUNK_RE.exec(t))) {
      matched++;
      const i = Number(m[1]); const n = Number(m[2]); const id = m[3] || '';
      if (!groups.has(id)) groups.set(id, { id, total: n, found: new Map() });
      const g = groups.get(id);
      if (g.total !== n) throw new Error(`chunk count mismatch in payload ${id || '(no id)'}: ${g.total} vs ${n}`);
      if (g.found.has(i) && g.found.get(i) !== m[4]) {
        throw new Error(`chunk ${i} of payload ${id || '(no id)'} arrived twice with different text` +
          (id ? '' : ' (two exports without ids: re-export with the current harvest.js)'));
      }
      g.found.set(i, m[4]);
    }
    if (starts > matched) {
      throw new Error(`a dump holds ${starts - matched} "AEPAYLOAD … START" marker(s) with no matching "AEPAYLOAD END": ` +
        'it was cut or changed when it was saved. Read that chunk again with get_page_text and save it whole.');
    }
  }
  return [...groups.values()];
}

/** The one-group view, kept for callers of the old API. */
export function chunksOf(texts) {
  const gs = chunkGroups(texts);
  if (gs.length > 1) throw new Error(`${gs.length} chunk sets found; use chunkGroups()`);
  return gs.length ? { found: gs[0].found, total: gs[0].total } : { found: new Map(), total: null };
}

export function assemble(texts) {
  const found = []; // [{ payload, via }]
  for (const p of fromInAppFiles(texts)) found.push({ payload: p, via: 'in-app-file' });

  const groups = chunkGroups(texts);
  const complete = groups.filter((g) => g.found.size === g.total);
  for (const g of groups) {
    const missing = [];
    for (let i = 0; i < g.total; i++) if (!g.found.has(i)) missing.push(i);
    if (missing.length) {
      throw new Error(`missing chunk(s) ${missing.join(', ')} of ${g.total}${g.id ? ' of payload ' + g.id : ''}. ` +
        (complete.length && g.id
          ? `${complete.length} other chunk set(s) are complete. If ${g.id} is an older state of the same harvest ` +
            `(it changed between two expose() calls), leave out every dump whose marker reads "AEPAYLOAD i/${g.total} ${g.id}"; ` +
            'otherwise expose() and read the missing chunks.'
          : 'expose() and read them before decoding.'));
    }
    const joined = Array.from({ length: g.total }, (_, i) => g.found.get(i)).join('');
    const p = JSON.parse(joined);
    if (!p || typeof p !== 'object' || !Array.isArray(p.items)) {
      throw new Error(`chunk set ${g.id || '(no id)'} is not a harvest payload (${joined.slice(0, 40)}): ` +
        'was expose() called before start() or restore()?');
    }
    found.push({ payload: p, via: `page-text-chunks(${g.total})` });
  }

  for (const t of texts) {
    if (!/^\s*\{/.test(t)) continue;
    try {
      const j = JSON.parse(t);
      if (j && typeof j === 'object' && (Array.isArray(j.items) || j.source)) found.push({ payload: j, via: 'plain-json' });
    } catch (e) { /* next */ }
  }
  if (!found.length) throw new Error('no payload found: expected an in-app saved result, AEPAYLOAD chunks, or a payload JSON');
  if (found.length === 1) return found[0];
  return { payload: mergePayloads(found.map((f) => f.payload)), via: 'merged(' + found.map((f) => f.via).join(', ') + ')' };
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
    blocked: p.blocked, suspectedWall: p.suspectedWall, parts: Array.isArray(p.parts) ? p.parts.length : 1,
    warnings: (p.warnings || []).map((w) => w.slice(0, 160)) };
  if (check) { console.log(JSON.stringify(summary, null, 1)); }
  else { process.stdout.write(JSON.stringify(p)); console.error(JSON.stringify(summary)); }
}
