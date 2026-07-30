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
for (const i of all) {
  const ev = evidenceOf(i);
  if (reqRe && !reqRe.test(i.title || '')) dropped.push({ ...i, why: 'off-category' });
  else if (i.rating == null) dropped.push({ ...i, why: 'no rating' });
  else if (i.rating < MIN_RATING) dropped.push({ ...i, why: `rating<${MIN_RATING}` });
  else if (!ev || ev < MIN_EVIDENCE) dropped.push({ ...i, why: `evidence<${MIN_EVIDENCE}` });
  else kept.push(i);
}

if (!kept.length) {
  console.log(JSON.stringify({ mode: MODE, ranked: [], dropped, note: 'no candidates survived filters' }, null, 2));
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

const ranked = kept
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
  .sort((a, b) => b.score - a.score)
  .slice(0, TOP);

console.log(
  JSON.stringify(
    {
      mode: MODE,
      weights: { quality: +wq.toFixed(3), volume: +wv.toFixed(3), brand: +wb.toFixed(3) },
      prior: PRIOR,
      brandDefault: anyBrand ? BRAND_DEFAULT : null,
      brandDefaulted,
      poolMeanRating: +(C * 4 + 1).toFixed(3),
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
