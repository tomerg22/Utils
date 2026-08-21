#!/usr/bin/env node
/* Rank AliExpress candidates by quality + volume (+ optional brand score).
 *
 * Usage:
 *   node rank.mjs --mode shortlist --top 10  < harvest.json
 *   node rank.mjs --mode final     --top 4   < finalists.json
 *   node rank.mjs --mode final --require 'מקציף|קצף' < finalists.json
 *
 * stdin: a JSON array of items, or {items:[...]}, or an array of extractor
 *        payloads (multiple pages) — all are accepted and merged/deduped by id.
 *
 * WHY BAYESIAN SHRINKAGE
 * Raw rating is not comparable across products: 5.0 from 3 reviews is weaker
 * evidence than 4.8 from 5,000. We shrink each rating toward the pool mean,
 * weighted by how much evidence backs it.
 *
 * TWO MODES, because the two data sources carry different evidence:
 *   shortlist - only the search page is loaded. We have rating + sold, never
 *               review count. Evidence = sold, with a large prior (m=300)
 *               because sold is bucketed and coarse.
 *   final     - detail pages fetched, exact reviewCount known from JSON-LD.
 *               Evidence = reviews, smaller prior (m=50).
 *
 * Volume is log-scaled because sold saturates at "10,000+" — at the top of a
 * category every product ties, so it must not dominate.
 *
 * BRAND SCORING IN A MIXED POOL
 * Most AliExpress listings are legitimately "No Brand". Treating a missing
 * brandScore as 0 would punish them for being ordinary, which is not what
 * step 6 of the skill is for — step 6 exists to demote counterfeits. So a
 * missing brandScore falls back to a NEUTRAL value (--brand-default, 0.5),
 * leaving researched-good brands above it and counterfeit-implausible ones
 * below it. When NO item carries a brandScore at all, the brand weight is
 * redistributed instead, so nothing is scored on absent data.
 */

import { median } from './lib.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};

const MODE = arg('mode', 'shortlist');
const TOP = Number(arg('top', 10));
const MIN_RATING = Number(arg('min-rating', 4.0));
const MIN_EVIDENCE = Number(arg('min-evidence', MODE === 'final' ? 10 : 100));
const W_QUALITY = Number(arg('w-quality', 0.6));
const W_VOLUME = Number(arg('w-volume', 0.25));
const W_BRAND = Number(arg('w-brand', 0.15));
const PRIOR = Number(arg('prior', MODE === 'final' ? 50 : 300));
const BRAND_DEFAULT = Number(arg('brand-default', 0.5));
const REQUIRE = arg('require', null); // regex on title — drops off-category items
const SPREAD = Math.max(0, Number(arg('spread', 0)));

/* All occurrences of a repeatable flag, e.g. --constraint wires --constraint 9v */
const argAll = (name) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === `--${name}`) out.push(argv[i + 1]);
  return out.filter(Boolean);
};

/* WHY --constraint EXISTS (measured 2026-08-21, Tapo C222 session)
 *
 * The user said "must have wires". A search found only pin-terminal modules,
 * so the requirement was silently demoted from a FILTER to a PREFERENCE and
 * traded against things the ranker liked better (current headroom, brand).
 * The result was a recommendation that failed the one stated requirement —
 * twice, including once AFTER the user supplied a wired counter-example.
 *
 * A requirement the user states is a filter, not a weight. There is no score
 * high enough to buy back a violated constraint.
 *
 * The second half matters as much: "I could not verify it" must never quietly
 * become "it qualifies". An item whose constraint status is unknown is held
 * OUT of `ranked` and listed in `unverified`, so the report cannot present it
 * as satisfying a requirement nobody checked.
 *
 * Items declare status per constraint:
 *   { constraints: { wires: 'pass' | 'fail' | 'unknown' } }
 */
const CONSTRAINTS = argAll('constraint');
const constraintStatus = (item, name) => {
  const c = item && item.constraints;
  const v = c && typeof c === 'object' ? c[name] : undefined;
  if (v === true || v === 'pass') return 'pass';
  if (v === false || v === 'fail') return 'fail';
  return 'unknown';
};

/* WHY --spread EXISTS (measured 2026-08-21)
 *
 * In shortlist mode the only volume signal is `sold`, which the storefront
 * BUCKETS and saturates at "10,000+". So the head of the ranking is packed
 * with saturated listings and a genuinely strong item at 700 sold sits far
 * below them — even when its review evidence is much better.
 *
 * That is not a scoring bug. It is a MISSING-DATA problem: the fine-grained
 * signal is the exact review count, and that only exists on the detail page,
 * which step 5 fetches for the shortlist only. So anything the shortlist does
 * not surface can never earn its review count. The failure is self-sealing.
 *
 * Real case: a 7-inch hand brush, 4.9 from 123 reviews and 700 sold, ranked
 * 32nd of 147 inside its own product class, while a competitor with 10,000+
 * sold and 28 reviews sat at the top. Top-10-by-score would never look at it.
 *
 * --spread K reserves K of the --top N slots for a STRATIFIED sample across
 * sold tiers, taking the best-scoring candidate from each tier starting at the
 * LOWEST (the head already covers the top). Step 5 then spends its detail
 * fetches across the whole evidence range instead of only its peak.
 */
function soldTier(ev) {
  // The storefront's own display buckets — the evidence range worth spanning.
  if (ev >= 10000) return { key: '10000+', floor: 10000 };
  if (ev >= 5000) return { key: '5000+', floor: 5000 };
  if (ev >= 3000) return { key: '3000+', floor: 3000 };
  if (ev >= 1000) return { key: '1000+', floor: 1000 };
  if (ev >= 500) return { key: '500+', floor: 500 };
  if (ev >= 100) return { key: '100+', floor: 100 };
  return { key: '<100', floor: 0 };
}

const read = () =>
  new Promise((res) => {
    let b = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (b += d));
    process.stdin.on('end', () => res(b));
  });

const raw = JSON.parse(await read());

// Accept: [items], {items}, or [{items},{items}] from multiple pages.
let pool = [];
const absorb = (x) => {
  if (!x) return;
  if (Array.isArray(x)) x.forEach(absorb);
  else if (Array.isArray(x.items)) pool.push(...x.items);
  else if (x.id) pool.push(x);
};
absorb(raw);

// Dedupe by id, preferring the record that carries the most data.
const byId = new Map();
for (const it of pool) {
  const prev = byId.get(it.id);
  const score = (o) => (o.reviews ? 2 : 0) + (o.rating ? 1 : 0);
  if (!prev || score(it) > score(prev)) byId.set(it.id, { ...prev, ...it });
}
const all = [...byId.values()];

const evidenceOf = (i) => (MODE === 'final' ? i.reviews : i.sold);
const reqRe = REQUIRE ? new RegExp(REQUIRE, 'i') : null;

const kept = [];
const dropped = [];
const unverified = [];
let requireDropped = 0;
for (const i of all) {
  const ev = evidenceOf(i);
  const violated = CONSTRAINTS.filter((n) => constraintStatus(i, n) === 'fail');
  const unknown = CONSTRAINTS.filter((n) => constraintStatus(i, n) === 'unknown');
  if (reqRe && !reqRe.test(i.title || '')) { dropped.push({ ...i, why: 'off-category' }); requireDropped++; }
  else if (violated.length) dropped.push({ ...i, why: `violates:${violated.join('+')}` });
  else if (i.rating == null) dropped.push({ ...i, why: 'no rating' });
  else if (i.rating < MIN_RATING) dropped.push({ ...i, why: `rating<${MIN_RATING}` });
  else if (!ev || ev < MIN_EVIDENCE) dropped.push({ ...i, why: `evidence<${MIN_EVIDENCE}` });
  // Unverified is held back LAST, so a genuinely bad item is reported as bad
  // rather than as merely unchecked.
  else if (unknown.length) unverified.push({ ...i, why: `unverified:${unknown.join('+')}` });
  else kept.push(i);
}

/* WHY THESE WARNINGS EXIST (measured 2026-08-21)
 *
 * A title-regex search for the word "wire" returned nothing, and that empty
 * result was reported to the user as "wired 9V modules do not exist". They do.
 * The user produced one within minutes. Titles simply do not mention physical
 * attributes — wires, connector type, mounting, enclosure, size — so a title
 * filter collapsing to zero says something about TITLES, never about the world.
 *
 * The warning is emitted in-band, at the exact moment the false conclusion
 * gets drawn, because prose in a doc did not stop it.
 */
const warnings = [];
const ABSENCE = 'absence-is-not-evidence: a title regex found nothing. Titles omit physical ' +
  'attributes (wires, connectors, mounting, enclosure, dimensions). Do NOT report that the ' +
  'product does not exist. Verify on the IMAGES and description of >=3 candidates first ' +
  '(listing.js + labels.sh).';
if (reqRe && all.length >= 10 && requireDropped >= 0.9 * all.length) warnings.push(ABSENCE);
if (CONSTRAINTS.length && unverified.length)
  warnings.push(`unverified-constraint: ${unverified.length} item(s) were NOT ranked because ` +
    `their status for [${CONSTRAINTS.join(', ')}] is unknown. Check them, do not assume they pass.`);

if (!kept.length) {
  if (reqRe && !warnings.includes(ABSENCE)) warnings.push(ABSENCE);
  if (CONSTRAINTS.length)
    warnings.push('no candidate satisfies the stated constraints. Report that plainly. ' +
      'NEVER substitute an item that fails a constraint, not even as an alternative, ' +
      'without saying in the same sentence that it fails it.');
  console.log(JSON.stringify({
    mode: MODE, constraints: CONSTRAINTS, ranked: [], unverified, warnings,
    considered: all.length, dropped,
    note: CONSTRAINTS.length ? 'no candidate satisfies the stated constraints'
                             : 'no candidates survived filters',
  }, null, 2));
  process.exit(0);
}

const norm = (r) => (r - 1) / 4; // 1..5 -> 0..1
const C = kept.reduce((a, i) => a + norm(i.rating), 0) / kept.length; // pool mean
const maxEv = Math.max(...kept.map(evidenceOf));
const medPrice = median(kept.map((i) => i.price).filter((p) => p != null));

const anyBrand = kept.some((i) => typeof i.brandScore === 'number');
const brandDefaulted = anyBrand
  ? kept.filter((i) => typeof i.brandScore !== 'number').length
  : 0;
// If no brand research has run at all, redistribute its weight so items are
// not all scored on data nobody supplied.
const wq = anyBrand ? W_QUALITY : W_QUALITY / (W_QUALITY + W_VOLUME);
const wv = anyBrand ? W_VOLUME : W_VOLUME / (W_QUALITY + W_VOLUME);
const wb = anyBrand ? W_BRAND : 0;

const scored = kept
  .map((i) => {
    const ev = evidenceOf(i);
    const p = norm(i.rating);
    const quality = (ev * p + PRIOR * C) / (ev + PRIOR);
    const volume = Math.log10(1 + ev) / Math.log10(1 + maxEv);
    // Missing brand data is NEUTRAL, not zero — see header note.
    const brand = typeof i.brandScore === 'number' ? i.brandScore : BRAND_DEFAULT;
    const score = wq * quality + wv * volume + wb * brand;

    const flags = [];
    if (i.discountPct != null && i.discountPct >= 80) flags.push('extreme-discount');
    if (medPrice && i.price != null && i.price < 0.25 * medPrice) flags.push('price-outlier-low');
    if (i.soldBucketed && i.sold >= 10000) flags.push('sold-saturated');
    if (MODE === 'final' && i.reviews != null && i.sold != null && i.reviews > i.sold)
      flags.push('reviews-exceed-sold');
    // Thin evidence behind a high rating is the classic fake-looking listing.
    if (MODE === 'final' && i.reviews != null && i.sold != null &&
        i.sold >= 1000 && i.reviews < 0.02 * i.sold)
      flags.push('few-reviews-for-sales');
    if (anyBrand && typeof i.brandScore !== 'number') flags.push('brand-unresearched');

    return {
      ...i,
      quality: +quality.toFixed(4),
      volume: +volume.toFixed(4),
      brandUsed: +brand.toFixed(3),
      score: +score.toFixed(4),
      flags,
    };
  })
  .sort((a, b) => b.score - a.score);

/* Selection. Without --spread this is exactly the old behaviour: top N by
 * score. With --spread K, the last K slots are filled by walking sold tiers
 * from the LOWEST upward and taking the best-scoring unpicked item in each,
 * cycling until K are filled or the pool is exhausted. Every chosen item is
 * labelled so the report can say which picks were stratified.
 */
const headCount = Math.max(1, TOP - Math.min(SPREAD, Math.max(0, TOP - 1)));
const head = scored.slice(0, headCount).map((i) => ({ ...i, pick: 'score' }));
const chosen = [...head];

if (SPREAD > 0) {
  const taken = new Set(head.map((i) => i.id));
  const buckets = new Map();
  for (const i of scored) {
    if (taken.has(i.id)) continue;
    const t = soldTier(evidenceOf(i));
    if (!buckets.has(t.key)) buckets.set(t.key, { floor: t.floor, items: [] });
    buckets.get(t.key).items.push(i);
  }
  // Lowest tier first: the head already represents the saturated top.
  const order = [...buckets.entries()].sort((a, b) => a[1].floor - b[1].floor);
  const want = TOP - chosen.length;
  let added = 0;
  while (added < want) {
    let progressed = false;
    for (const [key, b] of order) {
      if (added >= want) break;
      const next = b.items.shift();
      if (!next) continue;
      chosen.push({ ...next, pick: 'spread', spreadTier: key,
                    flags: [...next.flags, 'spread-pick'] });
      added++;
      progressed = true;
    }
    if (!progressed) break; // every tier drained
  }
}

const ranked = chosen;

console.log(
  JSON.stringify(
    {
      mode: MODE,
      weights: { quality: +wq.toFixed(3), volume: +wv.toFixed(3), brand: +wb.toFixed(3) },
      prior: PRIOR,
      brandDefault: anyBrand ? BRAND_DEFAULT : null,
      brandDefaulted,
      poolMeanRating: +(C * 4 + 1).toFixed(3),
      spread: SPREAD || null,
      spreadPicks: SPREAD ? ranked.filter((r) => r.pick === 'spread').length : 0,
      spreadTiers: SPREAD
        ? ranked.filter((r) => r.pick === 'spread').map((r) => r.spreadTier)
        : [],
      constraints: CONSTRAINTS,
      constraintViolations: dropped.filter((d) => d.why.startsWith('violates:')).length,
      unverifiedCount: unverified.length,
      unverified,
      warnings,
      considered: all.length,
      kept: kept.length,
      droppedCount: dropped.length,
      droppedReasons: dropped.reduce((a, d) => ({ ...a, [d.why]: (a[d.why] || 0) + 1 }), {}),
      ranked,
    },
    null,
    2
  )
);
