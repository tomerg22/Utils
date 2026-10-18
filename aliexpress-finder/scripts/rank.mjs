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
 *   final     - detail pages read. `reviews` is the listing's OWN rating count
 *               from the step-5 reader (the JSON-LD reviewCount is pooled
 *               across other sellers; see own-reviews-unknown below).
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
 *
 * THE RULE FOR A brandScore (fixed 2026-10-18): below 0.5 needs EVIDENCE OF
 * A PROBLEM (implausible specs or price, impersonation, bad independent
 * reviews). A house brand that was researched and turned up nothing either
 * way scores 0.5, the same as no data. SKILL.md used to say ~0.35 for it,
 * which ranked a researched house brand BELOW an identical unresearched or
 * brandless listing, so doing step 6 cost a listing score and skipping it
 * paid. A score of 0.35 must now name its problem; see SKILL.md step 6.
 */

import { median, parseSold, queryRelevance } from './lib.mjs';

/* --name value, or --name=value. An unknown --name is an error: a typo
 * such as --constriant silently dropped a hard requirement, and
 * --mode=final silently ran shortlist (review, 2026-10-18). */
const FLAGS = ['mode', 'top', 'min-rating', 'min-evidence', 'w-quality', 'w-volume', 'w-brand', 'prior',
  'brand-default', 'require', 'spread', 'constraint'];
const argv = process.argv.slice(2).flatMap((a) => (/^--[a-z-]+=/.test(a) ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a]));
for (let i = 0; i < argv.length; i++) {
  if (!/^--[a-z]/.test(argv[i])) continue;
  if (!FLAGS.includes(argv[i].slice(2))) {
    console.error('rank.mjs: unknown flag ' + argv[i] + ' (known: --' + FLAGS.join(', --') + ')');
    process.exit(2);
  }
  i++; // its value
}
/* A flag with no value (last on the line, or followed by another --flag)
 * is an error, never a silent NaN. Measured 2026-10-18: `--spread x`, a bare
 * `--spread` or `--top abc` made headCount NaN, slice(0, NaN) returned [],
 * and the output said kept 3, ranked 0, with no warning: "nothing
 * qualified", read off a typo. */
const die = (msg) => { console.error('rank.mjs: ' + msg); process.exit(2); };
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = argv[i + 1];
  if (v == null || /^--[a-z]/.test(v)) die(`--${name} needs a value`);
  return v;
};
const numArg = (name, dflt, { min = -Infinity, int = false } = {}) => {
  const raw = arg(name, null);
  if (raw == null) return dflt;
  // Number('') is 0: a blank value is refused, never read as zero.
  const n = /\S/.test(raw) ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < min || (int && !Number.isInteger(n))) {
    die(`--${name} must be ${int ? 'a whole number' : 'a number'}${min > -Infinity ? ' >= ' + min : ''}, got ${JSON.stringify(raw)}`);
  }
  return n;
};

const MODE = arg('mode', 'shortlist');
if (MODE !== 'shortlist' && MODE !== 'final') die(`--mode must be shortlist or final, got ${JSON.stringify(MODE)}`);
const TOP = numArg('top', 10, { min: 1, int: true });
const MIN_RATING = numArg('min-rating', 4.0);
const MIN_EVIDENCE = numArg('min-evidence', MODE === 'final' ? 10 : 100, { min: 0 });
const W_QUALITY = numArg('w-quality', 0.6, { min: 0 });
const W_VOLUME = numArg('w-volume', 0.25, { min: 0 });
const W_BRAND = numArg('w-brand', 0.15, { min: 0 });
const PRIOR = numArg('prior', MODE === 'final' ? 50 : 300, { min: 0 });
const BRAND_DEFAULT = numArg('brand-default', 0.5, { min: 0 });
const REQUIRE = arg('require', null); // regex on title — drops off-category items
const SPREAD = numArg('spread', 0, { min: 0, int: true });

/* All occurrences of a repeatable flag, e.g. --constraint wires --constraint 9v */
const argAll = (name) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== `--${name}`) continue;
    const v = argv[i + 1];
    if (v == null || /^--[a-z]/.test(v)) die(`--${name} needs a value`);
    out.push(v);
  }
  return out;
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
const envelopes = []; // payloads with a query, for the relevance check
const absorb = (x) => {
  if (!x) return;
  if (Array.isArray(x)) x.forEach(absorb);
  else if (Array.isArray(x.items)) { pool.push(...x.items); if (x.query) envelopes.push(x); }
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

/* WHY sold-unparsed EXISTS (measured 2026-09-25, the fidget-toys session)
 *
 * From 100,000 up the storefront writes "100K+ sold". The parser did not know
 * the K, so the two best sellers of a 1,228-item harvest came through with
 * sold = null, and this file dropped them as "evidence<100": a best seller
 * reported as a no-seller, with no warning. A sold text that does not parse is
 * a PARSER gap, never a verdict on the item. So it gets its own drop reason
 * and a loud warning, and the gap gets fixed instead of trusted.
 *
 * soldRaw is re-parsed here as well, so a hand-built finalist that carries
 * only soldRaw ("100K+") is scored on its number instead of being dropped.
 */
/* Numbers must be numbers. listing.js returns `reviews` as an OBJECT
 * ({ own, ownRating, header, pooledNote }); passed as is, it scored volume 0
 * for the whole pool with no warning (review, 2026-10-18). A numeric string
 * is read; anything else is set aside by name. */
const badNumbers = [];
for (const i of all) {
  // A sold TEXT ("1,000+") is read like soldRaw; a price that is not a
  // number only loses its price.
  if (typeof i.sold === 'string') { i.soldRaw = i.soldRaw || i.sold; i.sold = parseSold(i.sold); }
  if (i.price != null && typeof i.price !== 'number') {
    i.price = /^\s*\d+(\.\d+)?\s*$/.test(String(i.price)) ? Number(i.price) : null;
  }
  for (const k of ['reviews', 'pooledReviews', 'rating', 'ownRating']) {
    const v = i[k];
    if (v == null || typeof v === 'number') continue;
    if (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v)) { i[k] = Number(v); continue; }
    i.notANumber = (i.notANumber || []).concat(k);
  }
  if (i.notANumber) badNumbers.push(i);
}
for (const i of all) {
  if (i.sold == null && i.soldRaw != null) i.sold = parseSold(i.soldRaw);
  // A step-5 reader record carries soldRaw ("1,000+") but no soldBucketed,
  // so sold-saturated never fired for it and reviews-exceed-sold compared
  // the own count with a bucket FLOOR. The "+" says it is a floor.
  if (i.soldBucketed == null && i.soldRaw != null) i.soldBucketed = /\+|[KkMm]$/.test(String(i.soldRaw).trim());
}
const soldUnparsed = (i) => i.sold == null && !!(i.soldText || i.soldRaw);

/* WHY own-reviews-unknown EXISTS (measured 2026-09-25)
 *
 * The JSON-LD reviewCount is usually POOLED across other sellers' similar
 * items (header 5,479 vs the listing's own 1,090), and it used to be the
 * `reviews` field of every finalist. The step-5 reader now puts the listing's
 * own count in `reviews` and the pooled one in `pooledReviews`. A finalist
 * that has only the pooled number has an UNKNOWN own count: it is set aside
 * out loud, never ranked on the pooled number and never called thin.
 */
/* A finalist with no own count AND no pooled count is just as unknown: it
 * used to fall to the evidence floor as "evidence<10", with no warning,
 * which is the "called thin" outcome this rule exists to prevent. */
const ownReviewsUnknown = (i) => i.reviews == null;

/* WHICH RATING (fixed 2026-10-18). The step-5 reader's `rating` is the
 * JSON-LD ratingValue, which is POOLED across other sellers like the
 * JSON-LD reviewCount. The listing's own rating is `ownRating`, from the
 * same review block as the own count. Final mode shrinks a rating by the own
 * count, so it must use the own rating: a listing rated 4.1 by its own 1,090
 * buyers was ranked on the pool's 4.9. */
const ratingOf = (i) => (MODE === 'final' && typeof i.ownRating === 'number' ? i.ownRating : i.rating);

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
  if (i.notANumber) dropped.push({ ...i, why: 'not-a-number:' + i.notANumber.join('+') });
  else if (reqRe && !reqRe.test(i.title || '')) { dropped.push({ ...i, why: 'off-category' }); requireDropped++; }
  else if (violated.length) dropped.push({ ...i, why: `violates:${violated.join('+')}` });
  else if (ratingOf(i) == null) dropped.push({ ...i, why: 'no rating' });
  /* With no own count the only rating is the pooled one, so it is not
   * judged on it: set aside as unknown, never "rating<4" (review,
   * 2026-10-18). */
  else if (MODE === 'final' && ownReviewsUnknown(i)) dropped.push({ ...i, why: 'own-reviews-unknown' });
  else if (ratingOf(i) < MIN_RATING) dropped.push({ ...i, why: `rating<${MIN_RATING}` });
  else if (MODE !== 'final' && soldUnparsed(i)) dropped.push({ ...i, why: 'sold-unparsed' });
  // `--min-evidence 0` keeps a 0; unknown evidence (null) is never kept.
  else if (ev == null) dropped.push({ ...i, why: MIN_EVIDENCE > 0 ? `evidence<${MIN_EVIDENCE}` : 'evidence-unknown' });
  else if (ev < MIN_EVIDENCE || (MIN_EVIDENCE > 0 && !ev)) dropped.push({ ...i, why: `evidence<${MIN_EVIDENCE}` });
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
/* Off-query stream (measured 2026-10-17): "wired usb mouse" was served as
 * craft wire, 281 of 282 titles, and ranked without a word. Checked per
 * payload that names its query, whatever the harvester said. */
for (const env of envelopes) {
  const rel = queryRelevance(env.query, env.items.map((x) => x && x.title));
  if (rel.warning && !warnings.includes(rel.warning)) warnings.push(rel.warning);
  // The payload's own warnings (a part's off-query warning inside a
  // decode.mjs merge, merged-queries, …), all of them: on a merge this
  // file's own check sees the joined pool, where a good part can hide an
  // off-query one (review of the fix, 2026-10-18).
  for (const w of Array.isArray(env.warnings) ? env.warnings : []) {
    if (typeof w === 'string' && !warnings.includes(w)) warnings.push(w);
  }
}
if (badNumbers.length) {
  warnings.push(`not-a-number: ${badNumbers.length} item(s) carry a field that is not a number ` +
    `(${badNumbers.slice(0, 3).map((i) => i.id + ':' + i.notANumber.join('+')).join(', ')}). They were set aside. ` +
    'From listing.js pass reviews.own and reviews.ownRating, not the reviews object.');
}
const unparsed = all.filter(soldUnparsed);
if (unparsed.length)
  warnings.push(`sold-unparsed: ${unparsed.length} item(s) carry a sold text the parser could not ` +
    `read (${unparsed.slice(0, 3).map((i) => JSON.stringify(i.soldText || i.soldRaw)).join(', ')}). ` +
    (MODE === 'final'
      ? 'Their sold-based flags were skipped.'
      : 'They were set aside, NOT judged: they may be the best sellers. Fix parseSold/SOLD_RE ' +
        'in lib.mjs and every inlined copy, or open their detail pages.'));
const noOwn = MODE === 'final' ? dropped.filter((d) => d.why === 'own-reviews-unknown') : [];
if (noOwn.length)
  warnings.push(`own-reviews-unknown: ${noOwn.length} finalist(s) carry no own review count, only the pooled ` +
    `one or none (${noOwn.slice(0, 3).map((i) => i.id).join(', ')}). They were set aside, NOT ranked and NOT ` +
    'called thin: re-read the review block ("N ratings") on their detail pages. Never rank on the pooled number.');
if (CONSTRAINTS.length && unverified.length)
  warnings.push(`unverified-constraint: ${unverified.length} item(s) were NOT ranked because ` +
    `their status for [${CONSTRAINTS.join(', ')}] is unknown. Check them, do not assume they pass.`);

if (!all.length) {
  warnings.push('empty-input: no items were found in the input. An in-app harness file must go through ' +
    'decode.mjs first; a payload with items: [] means the harvest saved nothing.');
}

if (!kept.length) {
  /* Only when the REGEX emptied the pool. It used to fire whenever kept was
   * empty and --require was given, so a regex that matched every title (all
   * drops were constraint violations) was blamed: "a title regex found
   * nothing", sending the operator to fix a regex that worked. */
  if (reqRe && all.length && requireDropped === all.length && !warnings.includes(ABSENCE)) warnings.push(ABSENCE);
  /* Say WHY the ranking is empty. "No candidate satisfies the stated
   * constraints" used to be printed whatever emptied it: items unchecked on
   * the constraint, or dropped for no own count, were reported as failing
   * the user's requirement (review, 2026-10-18). */
  const failed = dropped.filter((d) => d.why.startsWith('violates:')).length;
  let note = 'no candidates survived filters';
  if (CONSTRAINTS.length && unverified.length) {
    note = 'no candidate is VERIFIED to satisfy the stated constraints: ' + unverified.length + ' are unchecked';
    warnings.push(`unverified-only: ${unverified.length} item(s) passed every other filter but their status for ` +
      `[${CONSTRAINTS.join(', ')}] is unknown. Check them; do NOT report that nothing satisfies the requirement.`);
  } else if (CONSTRAINTS.length && failed && failed === dropped.length) {
    note = 'no candidate satisfies the stated constraints';
    warnings.push('no candidate satisfies the stated constraints. Report that plainly. ' +
      'NEVER substitute an item that fails a constraint, not even as an alternative, ' +
      'without saying in the same sentence that it fails it.');
  } else if (CONSTRAINTS.length && failed) {
    note = 'no candidates survived filters; ' + failed + ' of ' + dropped.length + ' dropped items fail a stated constraint';
  }
  const out = JSON.stringify({
    mode: MODE, constraints: CONSTRAINTS, constraintViolations: failed, unverifiedCount: unverified.length,
    ranked: [], unverified, warnings,
    considered: all.length, dropped,
    droppedReasons: dropped.reduce((a, d) => ({ ...a, [d.why]: (a[d.why] || 0) + 1 }), {}),
    note,
  }, null, 2);
  // Flush before exit: process.exit() right after console.log cut piped
  // output at 64 KiB.
  await new Promise((r) => process.stdout.write(out + '\n', r));
  process.exit(0);
}

const norm = (r) => (r - 1) / 4; // 1..5 -> 0..1
const C = kept.reduce((a, i) => a + norm(ratingOf(i)), 0) / kept.length; // pool mean
const maxEv = Math.max(...kept.map(evidenceOf));
const medPrice = median(kept.map((i) => i.price).filter((p) => p != null));

const anyBrand = kept.some((i) => typeof i.brandScore === 'number');
const brandDefaulted = anyBrand
  ? kept.filter((i) => typeof i.brandScore !== 'number').length
  : 0;
// If no brand research has run at all, redistribute its weight so items are
// not all scored on data nobody supplied.
if ((anyBrand ? W_QUALITY + W_VOLUME + W_BRAND : W_QUALITY + W_VOLUME) <= 0) {
  die('the weights add up to 0' + (anyBrand ? '' : ' (no item has a brandScore, so --w-brand is not used)') +
    ': every score would be NaN');
}
const wq = anyBrand ? W_QUALITY : W_QUALITY / (W_QUALITY + W_VOLUME);
const wv = anyBrand ? W_VOLUME : W_VOLUME / (W_QUALITY + W_VOLUME);
const wb = anyBrand ? W_BRAND : 0;

const scored = kept
  .map((i) => {
    const ev = evidenceOf(i);
    const p = norm(ratingOf(i));
    const quality = ev + PRIOR > 0 ? (ev * p + PRIOR * C) / (ev + PRIOR) : p;
    const volume = maxEv > 0 ? Math.log10(1 + ev) / Math.log10(1 + maxEv) : 0;
    // Missing brand data is NEUTRAL, not zero — see header note.
    const brand = typeof i.brandScore === 'number' ? i.brandScore : BRAND_DEFAULT;
    const score = wq * quality + wv * volume + wb * brand;

    const flags = [];
    if (i.discountPct != null && i.discountPct >= 80) flags.push('extreme-discount');
    if (medPrice && i.price != null && i.price < 0.25 * medPrice) flags.push('price-outlier-low');
    if (i.soldBucketed && i.sold >= 10000) flags.push('sold-saturated');
    // Against a bucket floor ("1,000+") more reviews than the floor is normal.
    if (MODE === 'final' && i.reviews != null && i.sold != null && i.reviews > i.sold && !i.soldBucketed)
      flags.push('reviews-exceed-sold');
    // A pooled rating with an own count: the reader's ownRating was not passed.
    if (MODE === 'final' && typeof i.ownRating !== 'number' && i.pooledReviews != null && i.reviews != null &&
        i.pooledReviews !== i.reviews)
      flags.push('rating-may-be-pooled');
    // Thin evidence behind a high rating is the classic fake-looking listing.
    if (MODE === 'final' && i.reviews != null && i.sold != null &&
        i.sold >= 1000 && i.reviews < 0.02 * i.sold)
      flags.push('few-reviews-for-sales');
    if (anyBrand && typeof i.brandScore !== 'number') flags.push('brand-unresearched');
    // The brand weight can only demote by 0.075, so a counterfeit with strong
    // evidence can stay in the top 4: name it so the report says so.
    if (typeof i.brandScore === 'number' && i.brandScore < 0.2) flags.push('brand-implausible');

    return {
      ...i,
      ratingUsed: ratingOf(i),
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
  var spreadTies = [];
  while (added < want) {
    let progressed = false;
    for (const [key, b] of order) {
      if (added >= want) break;
      const next = b.items.shift();
      if (!next) continue;
      // A tie inside the tier is also settled by input order: name it.
      const tiedWith = b.items.filter((x) => x.score === next.score).length;
      if (tiedWith) spreadTies.push(`${key}: ${next.id} tied with ${tiedWith}`);
      chosen.push({ ...next, pick: 'spread', spreadTier: key,
                    flags: [...next.flags, 'spread-pick'] });
      added++;
      progressed = true;
    }
    if (!progressed) break; // every tier drained
  }
  if (spreadTies.length) {
    warnings.push('tie-in-spread: a spread pick tied with other items of its tier, chosen by input order (' +
      spreadTies.slice(0, 4).join('; ') + '). Say the sample is one of several equal picks.');
  }
}

const ranked = chosen;

/* A tie across the cut (measured 2026-10-18): 14 items all at 0.9647 with
 * --top 10 kept the first 10 in INPUT order, and reversed input kept the
 * other end, with no word. The order is still input order, but the cut is
 * now named, with the tied items it left out. Checked AFTER the spread
 * picks, which may take some of the tied items back in. */
if (scored.length > headCount && scored[headCount - 1].score === scored[headCount].score) {
  const cut = scored[headCount - 1].score;
  const inIds = new Set(ranked.map((i) => i.id));
  const tied = scored.filter((i) => i.score === cut);
  const out = tied.filter((i) => !inIds.has(i.id));
  if (out.length) {
    warnings.push(`tie-at-cutoff: ${tied.length} items share score ${cut} across the cut; ${out.length} of them ` +
      `were left out by input order (${out.slice(0, 5).map((i) => i.id).join(', ')}` +
      `${out.length > 5 ? ', …' : ''}). Raise --top to include them, or say the shortlist split a tie.`);
  }
}

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
