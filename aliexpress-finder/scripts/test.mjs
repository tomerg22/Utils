#!/usr/bin/env node
/* Test suite for the aliexpress-finder skill.
 *
 *   node ~/.claude/skills/aliexpress-finder/scripts/test.mjs
 *
 * Covers the three defects found in the 2026-07-30 live run plus the scoring
 * guarantees the SKILL.md promises. Exits non-zero on any failure.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseSold, SOLD_RE, parseReviewBlock, median, clean, wallVerdict } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RANK = join(HERE, 'rank.mjs');
/* AEF_DIST=1 runs the whole suite against the dist/*.min.js copies, the
 * files the operator pastes (the main run starts that child run at the end).
 * SRC() is always the source text: drift guards and doc checks read it. */
const DIST = process.env.AEF_DIST === '1';
const SRC = (name) => readFileSync(join(HERE, name), 'utf8');
const RUN = (name) => (DIST ? readFileSync(join(HERE, 'dist', name.replace(/\.js$/, '.min.js')), 'utf8') : SRC(name));

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  FAIL ${name} ${detail}`); }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const rank = (items, args = []) => {
  const out = execFileSync('node', [RANK, ...args], {
    input: JSON.stringify(items), encoding: 'utf8',
  });
  return JSON.parse(out);
};

// ---------------------------------------------------------------- parseSold
console.log('\nparseSold — Hebrew storefront uses BOTH "," and "." as thousands sep');
eq('comma thousands "10,000+"', parseSold('10,000+'), 10000);
eq('DOT thousands "4.000+"  (the bug: used to yield 4)', parseSold('4.000+'), 4000);
eq('dot thousands "3.000+"', parseSold('3.000+'), 3000);
eq('plain "456"', parseSold('456'), 456);
eq('"1,000+"', parseSold('1,000+'), 1000);
eq('"900+"', parseSold('900+'), 900);
eq('millions "1,234,567"', parseSold('1,234,567'), 1234567);
eq('null passthrough', parseSold(null), null);
eq('undefined passthrough', parseSold(undefined), null);
eq('empty string', parseSold(''), null);
eq('garbage', parseSold('abc'), null);
eq('bidi marks stripped', parseSold('\u200e10,000+\u200f'), 10000);
eq('inner whitespace', parseSold('10, 000 +'), 10000);
eq('real decimal NOT treated as thousands', parseSold('1.5'), 1.5);
eq('short group is not a thousands sep', parseSold('10,00'), null);

// The evidence floor is what the bug actually broke: shortlist mode drops
// anything under 100, so 4.000+ -> 4 silently deleted a 4,000-sold listing.
ok('dot-thousands value clears the shortlist evidence floor',
  parseSold('4.000+') >= 100, `parsed ${parseSold('4.000+')}`);

/* WHY (measured 2026-09-25, the fidget-toys session). From 100,000 up the
 * storefront writes "100K+ sold". The parser returned null for it, so the two
 * best sellers of a 1,228-item harvest (orders-sort positions 1 and 2) came
 * through with sold = null and rank.mjs dropped them as "evidence<100". */
console.log('\nparseSold — "100K+" (the K suffix used to drop the best sellers)');
eq('"100K+"  (the bug: used to yield null)', parseSold('100K+'), 100000);
eq('lower-case "100k"', parseSold('100k'), 100000);
eq('decimal "1.2K"', parseSold('1.2K'), 1200);
eq('decimal comma "1,2K"', parseSold('1,2K'), 1200);
eq('"12.5K+"', parseSold('12.5K+'), 12500);
eq('"1.1K" has no float noise', parseSold('1.1K'), 1100);
eq('"2M+"', parseSold('2M+'), 2000000);
eq('bidi marks around "100K+"', parseSold('\u200e100K+\u200f'), 100000);
eq('a bare "K" is not a number', parseSold('K'), null);
eq('"K100" is not a number', parseSold('K100'), null);
eq('the bucket below is unchanged: "50,000+"', parseSold('50,000+'), 50000);
ok('"100K+" clears the shortlist evidence floor', parseSold('100K+') >= 100);

// --------------------------------- browser-side files: parseSold drift guard
// extract.js AND harvest.js each inline a copy because they run in the browser
// and cannot import lib.mjs. Both copies must agree with lib.mjs.
console.log('\nbrowser files inline parseSold — assert no copy has drifted');
const SHARED_FIXTURES = ['10,000+', '4.000+', '3.000+', '456', '1,000+', '900+', '1,234,567',
  '', 'abc', '1.5', '10,00', '\u200e10,000+\u200f', '10, 000 +',
  '100K+', '100k', '1.2K', '1,2K', '12.5K+', '1.1K', '2M+', '\u200e100K+\u200f', 'K', 'K100', '50,000+'];
for (const file of ['extract.js', 'harvest.js']) {
  const src = readFileSync(join(HERE, file), 'utf8');
  const block = src.match(/\/\* @shared:parseSold:start \*\/([\s\S]*?)\/\* @shared:parseSold:end \*\//);
  ok(`${file} exposes the @shared:parseSold block`, !!block);
  if (!block) continue;
  const inlined = new Function(`${block[1]}; return parseSold;`)();
  const drift = SHARED_FIXTURES.filter((f) => JSON.stringify(inlined(f)) !== JSON.stringify(parseSold(f)));
  ok(`${file} copy agrees with lib.mjs on every fixture`, drift.length === 0, `drifted on ${JSON.stringify(drift)}`);
  eq(`${file} copy handles dot-thousands`, inlined('4.000+'), 4000);
  eq(`${file} copy handles "100K+"`, inlined('100K+'), 100000);
}

// ----------------------------------- browser-side files: SOLD_RE drift guard
/* The K defect had two halves: parseSold did not know "100K+", and before
 * that SOLD_RE never even captured it, because it allowed no letter between
 * the number and "sold". The regex is inlined in two browser files, so it
 * gets the same drift guard as parseSold. */
console.log('\nSOLD_RE — captures "100K+ sold", and no inlined copy has drifted');
const SOLD_TEXTS = [['100K+ sold', '100K+'], ['10,000+ sold', '10,000+'], ['50,000+ sold', '50,000+'],
  ['4.000+ נמכרו', '4.000+'], ['1,000+ נמכרו', '1,000+'], ['100K+ נמכרו', '100K+'], ['1.2K sold', '1.2K'],
  ['2M+ sold', '2M+'], ['302 sold', '302'], ['sold out', null], ['', null]];
const soldOf = (re, t) => { const m = t.match(re); return m ? m[1].replace(/\s/g, '') : null; };
for (const [t, want] of SOLD_TEXTS) eq(`lib SOLD_RE on ${JSON.stringify(t)}`, soldOf(SOLD_RE, t), want);
for (const file of ['extract.js', 'harvest.js']) {
  const src = readFileSync(join(HERE, file), 'utf8');
  const block = src.match(/\/\* @shared:soldRe:start \*\/([\s\S]*?)\/\* @shared:soldRe:end \*\//);
  ok(`${file} exposes the @shared:soldRe block`, !!block);
  if (!block) continue;
  const re = new Function(`${block[1]}; return SOLD_RE;`)();
  eq(`${file} SOLD_RE is the lib.mjs pattern`, [re.source, re.flags], [SOLD_RE.source, SOLD_RE.flags]);
  const drift = SOLD_TEXTS.filter(([t]) => soldOf(re, t) !== soldOf(SOLD_RE, t)).map(([t]) => t);
  ok(`${file} SOLD_RE agrees with lib.mjs on every text`, drift.length === 0, `drifted on ${JSON.stringify(drift)}`);
}

// ------------------------------------------- browser files inline wallVerdict
// Same reason as parseSold: three browser files cannot import lib.mjs, so each
// carries a copy. They MUST agree, because a drifted copy means one entry point
// silently stops detecting walls.
console.log('\nbrowser files inline wallVerdict — assert no copy has drifted');
const WALL_CASES = [
  { name: 'punish url', sig: { url: 'https://he.aliexpress.com/_____tmd_____/punish?x5secdata=a' } },
  { name: 'captcha in text', sig: { url: 'x', text: 'Captcha Interception' } },
  { name: 'slider prompt', sig: { url: 'x', text: 'Please slide to verify' } },
  { name: 'hebrew slider', sig: { url: 'x', text: 'יש להחליק כדי לאמת' } },
  { name: 'served content', sig: { url: 'x', html: 'y'.repeat(300000), text: '', dataNodes: 4 } },
  { name: 'THE MISS', sig: { url: 'https://he.aliexpress.com/item/1.html',
                             html: 'y'.repeat(279005), text: 'y'.repeat(957), dataNodes: 0 } },
  { name: 'punish string, no data', sig: { url: 'x', html: 'var punish=1;', text: '', dataNodes: 0 } },
  { name: 'short malformed page', sig: { url: 'x', html: '<html>no payload</html>', text: '', dataNodes: 0 } },
];
for (const file of ['extract.js', 'harvest.js', 'listing.js']) {
  const src2 = readFileSync(join(HERE, file), 'utf8');
  const block = src2.match(/\/\* @shared:wallVerdict:start \*\/([\s\S]*?)\/\* @shared:wallVerdict:end \*\//);
  ok(`${file} exposes the @shared:wallVerdict block`, !!block);
  if (!block) continue;
  const inlined = new Function(`${block[1]}; return wallVerdict;`)();
  const drift = WALL_CASES.filter((c) =>
    JSON.stringify(inlined(c.sig)) !== JSON.stringify(wallVerdict(c.sig)));
  ok(`${file} copy agrees with lib.mjs on every wall case`, drift.length === 0,
    `drifted on ${JSON.stringify(drift.map((d) => d.name))}`);
}

console.log('\nwallVerdict — the quiet wall that the old boolean check missed');
{
  // THE REGRESSION THIS EXISTS FOR (2026-08-25). Detail pages returned 279,005
  // bytes of HTML, 957 bytes of body text and zero JSON-LD. The old check saw
  // no marker, the operator called it "a rendering fault, not a wall", and then
  // reported a review count as "not obtainable" when the page held 1,633.
  const miss = wallVerdict({ url: 'https://he.aliexpress.com/item/1005009457140096.html',
    html: 'y'.repeat(279005), text: 'y'.repeat(957), dataNodes: 0 });
  eq('big html + empty body + no data is NOT called clear', miss.state, 'suspect');
  ok('the miss names the shape that caused it',
    miss.markers.includes('big-html-no-content'), JSON.stringify(miss.markers));
  ok('a suspected wall MANDATES a screenshot, not more scraping',
    /SCREENSHOT/.test(miss.note) && /screenshot/i.test(miss.note), miss.note);
  ok('a suspected wall forbids reporting data as unavailable',
    /do NOT report the\s+data as unavailable|unavailable/i.test(miss.note), miss.note);

  // A quiet marker must never be dismissible by argument.
  const quiet = wallVerdict({ url: 'x', html: 'window.punish=1', text: '', dataNodes: 0 });
  eq('a punish string with no data is suspect, not clear', quiet.state, 'suspect');

  // ...but content coming back IS proof no wall withheld it, so no false alarms.
  const served = wallVerdict({ url: 'x', html: 'window.punish=1'.padEnd(300000, 'y'),
    text: 'plenty of real text', dataNodes: 60 });
  eq('a page that served data is clear even with punish in the html', served.state, 'clear');

  // A loud wall still wins, and still says stop.
  const loud = wallVerdict({ url: 'https://he.aliexpress.com/_____tmd_____/punish?x5secdata=a' });
  eq('loud wall is blocked', loud.state, 'blocked');
  ok('loud wall says stop this turn', /STOP and tell the user/.test(loud.note), loud.note);

  // A short malformed page keeps its more useful name.
  eq('short malformed page is not cried wolf over',
    wallVerdict({ url: 'x', html: '<html>no payload</html>', text: '', dataNodes: 0 }).state, 'clear');
}

// ------------------------------------------------------------- misc helpers
console.log('\nhelpers');
eq('median odd', median([3, 1, 2]), 2);
eq('median even', median([1, 2, 3, 4]), 2.5);
eq('median empty', median([]), null);
eq('clean strips bidi + collapses ws', clean('\u200ea   b\u200f'), 'a b');

// ------------------------------------------------------- Bayesian shrinkage
console.log('\nrank — Bayesian shrinkage beats raw rating');
{
  // --min-evidence 1 so the planted item is scored rather than filtered out;
  // the point here is the SCORE comparison, not the evidence floor.
  const r = rank([
    { id: 'thin', title: 'planted', rating: 5.0, reviews: 4, sold: 5000 },
    { id: 'thick', title: 'genuine', rating: 4.9, reviews: 4790, sold: 5000 },
  ], ['--mode', 'final', '--top', '5', '--min-evidence', '1']);
  const thin = r.ranked.find((x) => x.id === 'thin');
  const thick = r.ranked.find((x) => x.id === 'thick');
  ok('5.0-from-4-reviews ranks BELOW 4.9-from-4790', thick.score > thin.score,
    `thick ${thick.score} vs thin ${thin.score}`);
  ok('thin item is flagged few-reviews-for-sales', thin.flags.includes('few-reviews-for-sales'),
    JSON.stringify(thin.flags));
}

// -------------------------------------------------------------- brand logic
console.log('\nrank — brand scoring must not punish legitimately brandless items');
{
  const base = [
    { id: 'a', title: 'no brand, strong evidence', rating: 4.9, reviews: 5775, sold: 10000 },
    { id: 'b', title: 'good brand', rating: 4.9, reviews: 1025, sold: 5000, brandScore: 0.85 },
    { id: 'c', title: 'counterfeit-implausible', rating: 4.9, reviews: 1025, sold: 5000, brandScore: 0.02 },
  ];
  const r = rank(base, ['--mode', 'final', '--top', '5']);
  const g = (id) => r.ranked.find((x) => x.id === id);

  eq('brand weight active when any brandScore present', r.weights.brand, 0.15);
  eq('brandDefault reported', r.brandDefault, 0.5);
  eq('one item counted as brand-defaulted', r.brandDefaulted, 1);
  ok('brandless item gets NEUTRAL 0.5, not 0 (the bug)', g('a').brandUsed === 0.5,
    `brandUsed=${g('a').brandUsed}`);
  ok('brandless item is flagged brand-unresearched', g('a').flags.includes('brand-unresearched'));
  ok('counterfeit-implausible scores below the brandless item',
    g('c').score < g('a').score, `c ${g('c').score} vs a ${g('a').score}`);
  ok('good brand scores above the counterfeit', g('b').score > g('c').score);

}
{
  // REGRESSION GUARD for the real inversion. With IDENTICAL evidence and only
  // brand differing, the old brandScore->0 rule scored the counterfeit 0.838
  // and the brandless item 0.835 — promoting the fake, the exact outcome
  // step 6 of the skill exists to prevent.
  const r = rank([
    { id: 'brandless', title: 'no brand', rating: 4.9, reviews: 1025, sold: 5000 },
    { id: 'counterfeit', title: 'fake famous brand', rating: 4.9, reviews: 1025, sold: 5000, brandScore: 0.02 },
  ], ['--mode', 'final', '--top', '5']);
  const g = (id) => r.ranked.find((x) => x.id === id);
  ok('REGRESSION: with identical evidence, a 0.02 counterfeit must NOT outrank a brandless item',
    g('brandless').score > g('counterfeit').score,
    `brandless ${g('brandless').score} vs counterfeit ${g('counterfeit').score}`);
  eq('and brandless ranks first', r.ranked[0].id, 'brandless');
}
{
  const r = rank([
    { id: 'a', title: 'x', rating: 4.9, reviews: 100, sold: 5000 },
    { id: 'b', title: 'y', rating: 4.8, reviews: 200, sold: 5000 },
  ], ['--mode', 'final', '--top', '5']);
  eq('no brandScore anywhere -> brand weight redistributed to 0', r.weights.brand, 0);
  eq('quality reweighted', r.weights.quality, 0.706);
  eq('brandDefault null when unused', r.brandDefault, null);
}

// ------------------------------------------------------------- input shapes
console.log('\nrank — input shapes and dedupe');
{
  const item = { id: '1', title: 't', rating: 4.8, reviews: 500, sold: 5000 };
  const bare = rank([item], ['--mode', 'final']);
  const wrapped = rank({ items: [item] }, ['--mode', 'final']);
  const pages = rank([{ items: [item] }, { items: [item] }], ['--mode', 'final']);
  eq('bare array accepted', bare.kept, 1);
  eq('{items} accepted', wrapped.kept, 1);
  eq('multi-page payloads deduped by id', pages.kept, 1);
}
{
  // The record carrying more data must win the merge.
  const r = rank([
    { id: '1', title: 't', rating: 4.8, sold: 5000 },
    { id: '1', title: 't', rating: 4.8, sold: 5000, reviews: 900 },
  ], ['--mode', 'final']);
  eq('merge prefers the record with reviews', r.ranked[0].reviews, 900);
}

// ----------------------------------------------------------------- filters
console.log('\nrank — filters');
{
  const r = rank([
    { id: 'keep', title: 'מקציף חלב', rating: 4.8, reviews: 500, sold: 5000 },
    { id: 'norating', title: 'seo junk', rating: null, reviews: null, sold: null },
    { id: 'lowrating', title: 'מקציף חלב', rating: 3.2, reviews: 500, sold: 5000 },
    { id: 'thinev', title: 'מקציף חלב', rating: 4.9, reviews: 2, sold: 10 },
  ], ['--mode', 'final', '--top', '9']);
  eq('only the good item survives', r.ranked.map((x) => x.id), ['keep']);
  // In final mode a record with no rating and no own count is set aside out
  // loud as own-reviews-unknown (recheck, 2026-10-19, R-F11); "no rating"
  // (the SEO-junk filter) is a shortlist matter, checked just below.
  eq('drop reasons tallied', r.droppedReasons, { 'own-reviews-unknown': 1, 'rating<4': 1, 'evidence<10': 1 });
  const s = rank([
    { id: 'keep', title: 'מקציף חלב', rating: 4.8, sold: 5000 },
    { id: 'norating', title: 'seo junk', rating: null, reviews: null, sold: null },
  ], ['--mode', 'shortlist']);
  eq('shortlist: SEO junk with all fields null is dropped as "no rating"', s.droppedReasons, { 'no rating': 1 });
}
{
  // Off-category guard: page 2 of a real search returned eye cream + makeup brushes.
  const r = rank([
    { id: 'frother', title: 'מקציף חלב חשמלי לקפה', rating: 4.8, reviews: 500, sold: 5000 },
    { id: 'eyecream', title: 'קרם עיניים רטינול מבהיר', rating: 4.9, reviews: 900, sold: 10000 },
  ], ['--mode', 'final', '--require', 'מקציף|קצף']);
  eq('--require drops off-category items', r.ranked.map((x) => x.id), ['frother']);
  eq('off-category counted', r.droppedReasons['off-category'], 1);
}

// ------------------------------------------------------------------- flags
console.log('\nrank — flags');
{
  const r = rank([
    { id: 'a', title: 'x', rating: 4.8, reviews: 500, sold: 10000, soldBucketed: true, price: 3, discountPct: 88 },
    { id: 'b', title: 'y', rating: 4.8, reviews: 500, sold: 5000, price: 40 },
    { id: 'c', title: 'z', rating: 4.8, reviews: 9000, sold: 5000, price: 40 },
  ], ['--mode', 'final', '--top', '9']);
  const f = (id) => r.ranked.find((x) => x.id === id).flags;
  ok('extreme-discount at >=80%', f('a').includes('extreme-discount'));
  ok('sold-saturated at bucketed 10000', f('a').includes('sold-saturated'));
  ok('price-outlier-low below 25% of median', f('a').includes('price-outlier-low'));
  ok('reviews-exceed-sold', f('c').includes('reviews-exceed-sold'));
  eq('clean item has no flags', f('b'), []);
}

// ------------------------------------------------------------ empty result
console.log('\nrank — degenerate input');
{
  const r = rank([{ id: 'x', title: 'j', rating: null, reviews: null, sold: null }], ['--mode', 'final']);
  eq('empty ranked list', r.ranked, []);
  ok('explains itself', /no candidates/.test(r.note || ''));
}


// ------------------------------------------------------------- harvest.js
/* harvest.js is an IIFE that assigns window.__aeHarvest. Load it with a fake
 * `window` and a fake `fetch` so its real logic is exercised here — not a
 * lookalike reimplementation, which is how a confidently-wrong "proof" happens.
 */
console.log('\nharvest.js — URL construction');
const harvestSrc = RUN('harvest.js');   // the code that runs (dist/ under AEF_DIST=1)
const harvestText = SRC('harvest.js'); // the source text (markers, comments)
const loadHarvest = (fetchImpl) => {
  const win = {};
  new Function('window', 'fetch', harvestSrc)(win, fetchImpl);
  return win.__aeHarvest;
};

/* Build a page in the same shape the real SSR payload has: an `init-data-start`
 * marker, then `= { data: {...} }` whose TOP key is unquoted. */
const makePage = ({ items = [], finished = false, total = 1234, page = 1 } = {}) => {
  const inner = JSON.stringify({
    hierarchy: {},
    data: { root: { fields: {
      pageInfo: { page, pageSize: 60, totalResults: total, finished },
      mods: { itemList: { content: items } },
    } } },
  });
  return `<html><script>/*--init-data-start--*/\nwindow._dida_config_._init_data_ = { data: ${inner} };\n</script></html>`;
};
const makeItem = (id, over = {}) => ({
  productId: id,
  title: { displayTitle: over.title || ('brush ' + id) },
  prices: { salePrice: { minPrice: over.price ?? 4.3, discount: over.discountPct ?? 80 },
            originalPrice: { minPrice: 20 } },
  evaluation: { starRating: over.rating ?? 4.8 },
  trade: { tradeDesc: (over.soldRaw || '10,000+') + ' נמכרו' },
});
const reply = (html, url = 'https://he.aliexpress.com/w/x.html') =>
  ({ url, text: async () => html });
/* localStorage stand-in: harvest.js saves its state there (2026-10-18). */
const fakeStorage = () => {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); }, _m: m };
};

{
  const H = loadHarvest(async () => reply(makePage()));
  const plan = H.start({ query: 'wire brush set' });
  const url = H.debugUrl();
  ok('slugifies the query into the wholesale path',
    url.includes('/w/wholesale-wire-brush-set.html'), url);
  eq('plan names the path without the query string', plan.searchPath, '/w/wholesale-wire-brush-set.html');
  ok('always sorts by orders', url.includes('SortType=total_tranpro_desc'));
  ok('applies the 4-star filter by default',
    url.includes('selectedSwitches=filterCode%3A4StarRating'), url);
  H.start({ query: 'a b', fourStar: false });
  ok('fourStar:false omits the rating filter',
    !H.debugUrl().includes('4StarRating'), H.debugUrl());
  const plan3 = H.start({ query: 'a b', extra: '&shpf_co=CN' });
  ok('extra params are appended', H.debugUrl().includes('&shpf_co=CN'));
  ok('plan reports that extras were applied without echoing them', plan3.extraApplied === true);
  let threw = false;
  try { H.start({ query: '   ' }); } catch (e) { threw = true; }
  ok('empty query throws rather than fetching a broken URL', threw);
}

/* WHY THIS GUARD EXISTS (measured 2026-09-14). The Chrome connector's
 * javascript_tool replaces a whole result with "[BLOCKED: Cookie/query string
 * data]" when the returned text carries a query string. start() used to
 * return the full first-page URL, and payload() the base URL — both carry
 * "?SortType=…&page=" — so in Chrome neither the plan nor the harvest could
 * ever be read back. Everything an operator is told to return must be free
 * of "?" and of cookie text; only debugUrl() may carry the URL. */
console.log('\nharvest.js — nothing returned to the operator carries a query string');
{
  const H = loadHarvest(async () => reply(makePage({ items: [makeItem('q1')], finished: true })));
  const plan = H.start({ query: 'wire brush set', extra: '&shpf_co=CN' });
  await H.step(1);
  for (const [name, text] of [['start()', JSON.stringify(plan)], ['status()', JSON.stringify(H.status())],
                              ['payload()', H.payload()]]) {
    ok(`${name} output has no "?"`, !text.includes('?'), text.slice(0, 120));
    ok(`${name} output has no "&shpf"`, !text.includes('shpf'), text.slice(0, 120));
  }
  ok('debugUrl() is the one place the full URL lives', H.debugUrl().includes('?SortType='));
}

console.log('\nharvest.js — a WALL must never look like a parse bug');
{
  // The punish page: no payload at all, and the redirect shows in the URL.
  const H = loadHarvest(async () => reply('<html>Please slide to verify</html>',
    'https://he.aliexpress.com/w/x.html/_____tmd_____/punish?x5secdata=abc'));
  H.start({ query: 'wire brush set' });
  const st = await H.step(3);
  eq('stop reason is blocked, not parse-error', st.stop, 'blocked');
  ok('blocked flag is set on status', st.blocked === true);
  ok('payload surfaces blocked', JSON.parse(H.payload()).blocked === true);
  ok('stops immediately, does not burn the budget', st.requests === 1, `requests=${st.requests}`);
}
{
  // Same, but the wall is only detectable in the BODY (no redirect in the URL).
  const H = loadHarvest(async () => reply('<html><div class="nc_1_nocaptcha">x</div></html>'));
  H.start({ query: 'wire brush set' });
  const st = await H.step(2);
  eq('body-only captcha markup is detected too', st.stop, 'blocked');
}
{
  // A genuinely malformed page is a parse-error — NOT silently treated as empty.
  const H = loadHarvest(async () => reply('<html>no payload here</html>'));
  H.start({ query: 'wire brush set' });
  const st = await H.step(2);
  eq('missing payload is a parse-error', st.stop, 'parse-error');
  ok('parse-error is not reported as blocked', st.blocked === false);
}

console.log('\nharvest.js — paging, dedupe and stop reasons');
{
  let served = 0;
  const H = loadHarvest(async (url) => {
    served++;
    const p = Number(new URL(url).searchParams.get('page'));
    if (p > 3) return reply(makePage({ items: [], finished: true, page: p }));
    // page 3 deliberately repeats one id from page 2 to prove dedupe works
    const ids = p === 3 ? ['p2-a', 'p3-a'] : [`p${p}-a`, `p${p}-b`];
    return reply(makePage({ items: ids.map((i) => makeItem(i)), page: p }));
  });
  H.start({ query: 'wire brush set' });
  const st = await H.step(10);
  eq('reads until the stream is dry', st.stop, 'exhausted');
  eq('pages read', st.pagesRead, 4);
  ok('duplicate id counted once', st.unique === 5, `unique=${st.unique}`);
  const pl = JSON.parse(H.payload());
  eq('verdict is exhausted-all-results', pl.coverage.verdict, 'exhausted-all-results');
  ok('claimedTotal is carried but marked unreliable',
    pl.coverage.claimedTotalIsUnreliable === true && pl.coverage.claimedTotal === 1234);
  ok('served one request per page plus the empty one', served === 4, `served=${served}`);
  eq('the end is named: an empty page', st.endSignal, 'empty-page');
}

/* WHY (measured 2026-09-29, signed-in Chrome, USD account). The harvester
 * used to stop on pageInfo.finished. "cheese grater" reported finished:true
 * on pages 1, 2 AND 3 while page 3 still held 60 ids never seen; the stream
 * served 60, 60, 60, 50 and then an empty page 5. The run stopped after
 * page 1 and would have called 60 of 230 items "exhausted-all-results".
 * These are the measured shapes, scaled down. */
console.log('\nharvest.js — finished:true is NOT a stop signal (the 2026-09-29 defect)');
{
  const sizes = [6, 6, 6, 5, 0]; // cheese grater: 60, 60, 60, 50, 0
  let served = 0;
  const H = loadHarvest(async (url) => {
    served++;
    const p = Number(new URL(url).searchParams.get('page'));
    const n = sizes[p - 1] ?? 0;
    return reply(makePage({ items: Array.from({ length: n }, (_, i) => makeItem(`cg${p}-${i}`)),
      finished: true, total: 60 * p, page: p }));
  });
  H.start({ query: 'cheese grater' });
  const st = await H.step(10);
  eq('reads past finished:true to the empty page', st.pagesRead, 5);
  eq('keeps every item the stream served (the bug kept only page 1)', st.unique, 23);
  eq('stop is exhausted', st.stop, 'exhausted');
  eq('the end signal is the empty page, not the flag', st.endSignal, 'empty-page');
  eq('one request per page, the empty one included', served, 5);
  const pl = JSON.parse(H.payload());
  ok('each page records its finished flag for diagnosis',
    pl.pages.every((pg) => pg.finished === true), JSON.stringify(pl.pages));
  eq('payload coverage names the end signal', pl.coverage.endSignal, 'empty-page');
}
{
  // vegetable slicer: 60, 59, 59, 48, 1, 0. A SHORT page is not the end.
  const sizes = [6, 6, 6, 4, 1, 0];
  const H = loadHarvest(async (url) => {
    const p = Number(new URL(url).searchParams.get('page'));
    const n = sizes[p - 1] ?? 0;
    return reply(makePage({ items: Array.from({ length: n }, (_, i) => makeItem(`vs${p}-${i}`)),
      finished: true, page: p }));
  });
  H.start({ query: 'vegetable slicer' });
  const st = await H.step(10);
  eq('a short page does not end the run: the item after it is kept', st.unique, 23);
  eq('pages read up to and including the empty one', st.pagesRead, 6);
}
{
  // A server that repeats itself: page 3 serves only ids already seen.
  const H = loadHarvest(async (url) => {
    const p = Number(new URL(url).searchParams.get('page'));
    const ids = p <= 2 ? [`d${p}-a`, `d${p}-b`] : ['d2-a', 'd2-b'];
    return reply(makePage({ items: ids.map((i) => makeItem(i)), page: p }));
  });
  H.start({ query: 'wire brush set' });
  const st = await H.step(10);
  eq('a page with no new ids ends the run', st.stop, 'exhausted');
  eq('that end is named', st.endSignal, 'no-new-ids');
  eq('it stops on that page, not later', st.pagesRead, 3);
  eq('the repeated ids are counted once', st.unique, 4);
}

/* Review finding F5 (confirmed live in the in-app browser): when a step()
 * tool call times out, its page loop keeps running. A second step() started
 * then fetched the same page again, found no new ids on it, and ended the
 * run as 'exhausted' with most pages unread (240 of 600 labelled as all
 * results). A second call must refuse while the first loop runs. */
console.log('\nharvest.js — a second step() while the first still runs is refused');
{
  const fetched = [];
  const H = loadHarvest((url) => new Promise((resolve) => {
    const p = Number(new URL(url).searchParams.get('page'));
    fetched.push(p);
    const items = p <= 6 ? [makeItem(`ov${p}-a`), makeItem(`ov${p}-b`)] : [];
    setTimeout(() => resolve(reply(makePage({ items, finished: true, page: p }))), 5);
  }));
  H.start({ query: 'wire brush set' });
  const first = H.step(10);            // the call whose tool timed out
  await new Promise((r) => setTimeout(r, 12));
  const mid = H.status();
  ok('status() shows the loop is running', mid.running === true, JSON.stringify(mid));
  const second = await H.step(10);     // the operator's retry
  ok('the second call is refused with an error', /already running/.test(second.err || ''), JSON.stringify(second));
  ok('and does not end the run', second.done === false, JSON.stringify(second));
  const st = await first;
  eq('the first loop reads to the empty page', st.endSignal, 'empty-page');
  eq('every item is kept', st.unique, 12);
  eq('no page was fetched twice', fetched, [1, 2, 3, 4, 5, 6, 7]);
  eq('running is cleared at the end', H.status().running, false);
}
{
  // The guard is released even when the loop stops on an error.
  const H = loadHarvest(async () => { throw new Error('network down'); });
  H.start({ query: 'wire brush set' });
  await H.step(2);
  eq('running is cleared after a fetch-error', H.status().running, false);
}

/* A hidden tab changes what works (measured 2026-09-29): a 100 ms timer fired
 * after 958 ms, a 2,500 ms one had not fired 45 s later, and screenshots,
 * zoom and get_page_text hung. status() must say so, so the operator knows. */
console.log('\nharvest.js — status() reports the tab visibility');
{
  const H = loadHarvest(async () => reply(makePage({ items: [makeItem('v1')] })));
  H.start({ query: 'wire brush set' });
  eq('no document at all is "unknown", not a guess', H.status().visibility, 'unknown');
  const winH = { document: { visibilityState: 'hidden' } };
  new Function('window', 'fetch', harvestSrc)(winH, async () => reply(makePage({ items: [makeItem('v2')] })));
  winH.__aeHarvest.start({ query: 'wire brush set' });
  eq('a hidden tab is reported as hidden', winH.__aeHarvest.status().visibility, 'hidden');
}
{
  const H = loadHarvest(async (url) => {
    const p = Number(new URL(url).searchParams.get('page'));
    return reply(makePage({ items: [makeItem('y' + p)], page: p }));
  });
  H.start({ query: 'wire brush set', maxPages: 3 });
  const st = await H.step(20);
  eq('page cap stops the run', st.stop, 'page-cap');
  eq('truncated verdict when capped', JSON.parse(H.payload()).coverage.verdict, 'truncated');
}
{
  const H = loadHarvest(async (url) => {
    const p = Number(new URL(url).searchParams.get('page'));
    return reply(makePage({ items: [makeItem('z' + p)], page: p }));
  });
  H.start({ query: 'wire brush set', maxRequests: 2 });
  const st = await H.step(20);
  eq('request budget stops the run', st.stop, 'request-budget');
  ok('never exceeds the budget', st.requests <= 2, `requests=${st.requests}`);
}
{
  const H = loadHarvest(async () => { throw new Error('network down'); });
  H.start({ query: 'wire brush set' });
  const st = await H.step(3);
  eq('network failure is its own stop reason', st.stop, 'fetch-error');
  ok('fetch-error is not reported as blocked', st.blocked === false);
}

console.log('\nharvest.js — resumability and record shape');
{
  const H = loadHarvest(async (url) => {
    const p = Number(new URL(url).searchParams.get('page'));
    if (p > 4) return reply(makePage({ items: [], finished: true, page: p }));
    return reply(makePage({ items: [makeItem('r' + p)], page: p }));
  });
  H.start({ query: 'wire brush set' });
  const a = await H.step(2);
  ok('partial run is not done', a.done === false && a.pagesRead === 2, JSON.stringify(a));
  const b = await H.step(2);
  ok('step() resumes where it left off', b.pagesRead === 4, JSON.stringify(b));
  const c = await H.step(2);
  ok('finishes on a later call', c.done === true && c.unique === 4, JSON.stringify(c));
}
{
  const H = loadHarvest(async () => reply(makePage({
    items: [makeItem('rec1', { title: 'hand brush', price: 13.73, rating: 4.9,
                               soldRaw: '4.000+', discountPct: 70 })],
    finished: true,
  })));
  H.start({ query: 'wire brush set' });
  await H.step(1);
  const pl = JSON.parse(H.payload());
  const it = pl.items[0];
  eq('id', it.id, 'rec1');
  eq('url built from id', it.url, 'https://he.aliexpress.com/item/rec1.html');
  eq('rating', it.rating, 4.9);
  eq('price', it.price, 13.73);
  eq('dot-thousands sold parsed (the 2026-07-30 bug)', it.sold, 4000);
  ok('soldBucketed detected', it.soldBucketed === true);
  eq('page number recorded for coverage reporting', it.page, 1);
  eq('reviews are null until step 5', it.reviews, null);
  eq('withRating counted', pl.withRating, 1);
}

console.log('\nharvest.js — payload feeds rank.mjs unchanged');
{
  const H = loadHarvest(async () => reply(makePage({
    items: [
      makeItem('good', { title: 'wire brush good', rating: 4.9, soldRaw: '5,000+' }),
      makeItem('thin', { title: 'wire brush thin', rating: 4.9, soldRaw: '12' }),
      makeItem('offcat', { title: 'garden hose', rating: 4.9, soldRaw: '9,000+' }),
    ],
    finished: true,
  })));
  H.start({ query: 'wire brush set' });
  await H.step(1);
  const r = rank(JSON.parse(H.payload()), ['--mode', 'shortlist', '--require', 'brush']);
  ok('rank.mjs consumes the harvest envelope', r.considered === 3, JSON.stringify(r.considered));
  eq('off-category dropped by --require', r.droppedReasons['off-category'], 1);
  eq('thin-evidence dropped', r.droppedReasons['evidence<100'], 1);
  eq('the good item survives', r.ranked.map((x) => x.id), ['good']);
}

/* The regression itself, end to end (measured 2026-09-25): the two best
 * sellers of the pool read "100K+ sold" and were dropped as "evidence<100".
 * They must now reach the shortlist, and a sold text nobody can parse must be
 * set aside out loud, never dropped as if the item did not sell. */
console.log('\nharvest.js + rank.mjs — "100K+ sold" best sellers reach the shortlist');
{
  const withDesc = (id, title, desc) => ({ ...makeItem(id, { title, rating: 4.9 }), trade: { tradeDesc: desc } });
  const H = loadHarvest(async () => reply(makePage({
    items: [
      withDesc('k1', 'glitter dumpling squishy', '100K+ sold'),
      withDesc('k2', 'nice cube squishy', '100K+ נמכרו'),
      withDesc('odd', 'odd squishy', 'lots sold'),
      makeItem('n1', { title: 'plain squishy', rating: 4.9, soldRaw: '50,000+' }),
      withDesc('none', 'brand new squishy', ''),
    ],
    finished: true,
  })));
  H.start({ query: 'stress ball' });
  await H.step(1);
  const p = JSON.parse(H.payload());
  const by = Object.fromEntries(p.items.map((i) => [i.id, i]));
  eq('"100K+ sold" -> 100000', by.k1.sold, 100000);
  eq('soldRaw keeps the page text', by.k1.soldRaw, '100K+');
  eq('a K bucket is still a bucket', by.k1.soldBucketed, true);
  eq('K with the Hebrew marker', by.k2.sold, 100000);
  eq('unreadable sold text: sold stays null', by.odd.sold, null);
  eq('unreadable sold text is kept verbatim for the ranker', by.odd.soldText, 'lots sold');
  eq('a parsed sold carries no soldText', by.n1.soldText, null);
  eq('no sold text at all is not a parse failure', by.none.soldText, null);
  const r = rank(p, ['--mode', 'shortlist']);
  ok('both 100K+ best sellers survive the shortlist',
    ['k1', 'k2'].every((id) => r.ranked.some((x) => x.id === id)), JSON.stringify(r.ranked.map((x) => x.id)));
  eq('the unreadable one is set aside as sold-unparsed, not "evidence<100"', r.droppedReasons['sold-unparsed'], 1);
  eq('the item with no sold text is still thin evidence', r.droppedReasons['evidence<100'], 1);
  ok('the ranker warns about the unreadable text by name',
    r.warnings.some((w) => w.startsWith('sold-unparsed') && w.includes('lots sold')), JSON.stringify(r.warnings));
}
{
  // A hand-built finalist that carries only soldRaw (no parsed sold) is scored on its number.
  const r = rank([
    { id: 'f1', title: 'dumpling', rating: 4.9, soldRaw: '100K+', reviews: 488 },
    { id: 'f2', title: 'cube', rating: 4.9, sold: 50000, soldRaw: '50,000+', reviews: 794 },
  ], ['--mode', 'final']);
  const f1 = r.ranked.find((x) => x.id === 'f1');
  eq('final mode re-parses soldRaw "100K+"', f1 && f1.sold, 100000);
  ok('few-reviews-for-sales now sees the real sold number',
    f1 && f1.flags.includes('few-reviews-for-sales'), JSON.stringify(f1 && f1.flags));
  eq('nothing unparsed, so no sold-unparsed warning', r.warnings.filter((w) => w.startsWith('sold-unparsed')), []);
}


// ---------------------------------------------------------------- --spread
/* --spread reserves slots for a stratified sample across SOLD TIERS, because
 * shortlist mode's only volume signal is bucketed, saturating `sold`. Without
 * it, step 5 only ever fetches review counts for the saturated head, so a
 * strong moderate-sold listing can never earn the one signal that would
 * promote it. See the header comment in rank.mjs.
 */
console.log('\nrank — --spread stratifies the shortlist across sold tiers');
{
  // Head is packed with saturated 10,000+ listings; the interesting items sit
  // in lower tiers where top-by-score never reaches.
  const pool = [];
  for (let i = 0; i < 8; i++) pool.push({ id: 'sat' + i, title: 'brush', rating: 4.9, sold: 10000 });
  pool.push({ id: 'mid', title: 'brush', rating: 4.9, sold: 2000 });
  pool.push({ id: 'low', title: 'brush', rating: 5.0, sold: 600 });
  pool.push({ id: 'tiny', title: 'brush', rating: 5.0, sold: 150 });

  const plain = rank(pool, ['--mode', 'shortlist', '--top', '6']);
  ok('without --spread the head is all saturated',
    plain.ranked.every((r) => r.sold >= 10000), JSON.stringify(plain.ranked.map((r) => r.sold)));
  eq('without --spread nothing is labelled spread', plain.spreadPicks, 0);
  ok('every pick is labelled score', plain.ranked.every((r) => r.pick === 'score'));

  const sp = rank(pool, ['--mode', 'shortlist', '--top', '6', '--spread', '3']);
  eq('spread picks are made', sp.spreadPicks, 3);
  eq('total size unchanged', sp.ranked.length, 6);
  ok('head is kept and still score-ranked',
    sp.ranked.filter((r) => r.pick === 'score').length === 3);
  const spreadIds = sp.ranked.filter((r) => r.pick === 'spread').map((r) => r.id);
  ok('spread reaches the low-sold items the head missed',
    spreadIds.includes('tiny') && spreadIds.includes('low') && spreadIds.includes('mid'),
    JSON.stringify(spreadIds));
  ok('spread picks are flagged',
    sp.ranked.filter((r) => r.pick === 'spread').every((r) => r.flags.includes('spread-pick')));
  ok('lowest tier is served first',
    sp.spreadTiers[0] === '100+', JSON.stringify(sp.spreadTiers));
  ok('tiers are distinct', new Set(sp.spreadTiers).size === sp.spreadTiers.length,
    JSON.stringify(sp.spreadTiers));
  ok('no duplicate ids across head and spread',
    new Set(sp.ranked.map((r) => r.id)).size === sp.ranked.length);
}
{
  // Degenerate settings must not crash or empty the list.
  const pool = [
    { id: 'a', title: 'brush', rating: 4.9, sold: 10000 },
    { id: 'b', title: 'brush', rating: 4.8, sold: 400 },
  ];
  const r1 = rank(pool, ['--mode', 'shortlist', '--top', '2', '--spread', '99']);
  ok('spread larger than top still keeps a head', r1.ranked.some((x) => x.pick === 'score'));
  eq('never returns more than top', r1.ranked.length, 2);
  const r2 = rank(pool, ['--mode', 'shortlist', '--top', '10', '--spread', '5']);
  ok('spread on a pool smaller than top does not duplicate',
    new Set(r2.ranked.map((x) => x.id)).size === r2.ranked.length);
  ok('spread cannot invent items', r2.ranked.length <= 2, `got ${r2.ranked.length}`);
  const r3 = rank(pool, ['--mode', 'shortlist', '--top', '2', '--spread', '0']);
  eq('spread 0 is the old behaviour', r3.spread, null);
}
{
  // final mode: evidence is `reviews`, so tiers must follow reviews there.
  const pool = [
    { id: 'big', title: 'brush', rating: 4.8, reviews: 12000, sold: 10000 },
    { id: 'small', title: 'brush', rating: 4.9, reviews: 120, sold: 700 },
  ];
  const r = rank(pool, ['--mode', 'final', '--top', '2', '--spread', '1']);
  ok('final mode tiers on reviews, not sold',
    r.ranked.find((x) => x.pick === 'spread').id === 'small',
    JSON.stringify(r.ranked.map((x) => [x.id, x.pick])));
}

// ------------------------------------------- harvest.js captures thumbnails
/* Physical attributes (wires, connector, enclosure) are never in the title, so
 * the grid thumbnail is the cheap screen. The CDN is a different host from the
 * search endpoint, so checking images costs nothing against the request budget.
 */
console.log('\nharvest.js — grid thumbnails are captured for image screening');
{
  const item = makeItem('t1');
  item.image = { imgUrl: '//ae-pic-a1.aliexpress-media.com/kf/Sthumb.jpg' };
  const h = loadHarvest(async () => reply(makePage({ items: [item], finished: true })));
  h.start({ query: 'x' });
  await h.step(1);
  const got = JSON.parse(h.payload()).items[0];
  eq('thumbnail captured and protocol-normalised', got.image,
    'https://ae-pic-a1.aliexpress-media.com/kf/Sthumb.jpg');

  const bare = makeItem('t2'); // no image field at all
  const h2 = loadHarvest(async () => reply(makePage({ items: [bare], finished: true })));
  h2.start({ query: 'x' });
  await h2.step(1);
  eq('missing image is null, not undefined', JSON.parse(h2.payload()).items[0].image, null);
}

// ------------------------------------------------- hard constraints (D1)
/* The user said "must have wires". The requirement got demoted to a
 * preference and traded against score, producing a recommendation that failed
 * the one stated requirement — twice. A constraint is a filter, not a weight.
 */
console.log('\nrank — a stated constraint is a FILTER, never a weight');
{
  const pool = [
    { id: 'nowires', title: 'great module', rating: 5, sold: 10000, reviews: 5000,
      constraints: { wires: 'fail' } },
    { id: 'wires', title: 'humbler module', rating: 4.5, sold: 200, reviews: 40,
      constraints: { wires: 'pass' } },
  ];
  const r = rank(pool, ['--mode', 'final', '--top', '4', '--constraint', 'wires']);
  const ids = r.ranked.map((x) => x.id);
  ok('constraint-failing item is NEVER ranked, however good its score',
    !ids.includes('nowires'), JSON.stringify(ids));
  ok('constraint-passing item is ranked even though it scores lower',
    ids.includes('wires'), JSON.stringify(ids));
  eq('violation is counted', r.constraintViolations, 1);
  ok('violation names the constraint',
    Object.keys(r.droppedReasons).some((k) => k === 'violates:wires'),
    JSON.stringify(r.droppedReasons));

  // Without the flag nothing changes — constraints are opt-in.
  const r0 = rank(pool, ['--mode', 'final', '--top', '4']);
  ok('no --constraint means old behaviour', r0.ranked.map((x) => x.id).includes('nowires'));
}
{
  // "I did not check" must not become "it qualifies".
  const pool = [
    { id: 'unchecked', title: 'module', rating: 4.9, sold: 5000, reviews: 900 },
    { id: 'checked', title: 'module', rating: 4.2, sold: 300, reviews: 60,
      constraints: { wires: 'pass' } },
  ];
  const r = rank(pool, ['--mode', 'final', '--top', '4', '--constraint', 'wires']);
  const ids = r.ranked.map((x) => x.id);
  ok('unverified item is held OUT of ranked', !ids.includes('unchecked'), JSON.stringify(ids));
  ok('unverified item is surfaced, not silently dropped',
    r.unverified.map((x) => x.id).includes('unchecked'));
  eq('unverified is counted', r.unverifiedCount, 1);
  ok('unverified raises a warning',
    r.warnings.some((w) => /unverified-constraint/.test(w)), JSON.stringify(r.warnings));
}
{
  // Nothing qualifies: the report must say so, not substitute a violator.
  const pool = [
    { id: 'a', title: 'module', rating: 5, sold: 10000, reviews: 900, constraints: { wires: 'fail' } },
    { id: 'b', title: 'module', rating: 4.9, sold: 9000, reviews: 800, constraints: { wires: 'fail' } },
  ];
  const r = rank(pool, ['--mode', 'final', '--top', '4', '--constraint', 'wires']);
  eq('nothing qualifies -> empty ranked', r.ranked.length, 0);
  ok('note says constraints unsatisfied', /no candidate satisfies/.test(r.note || ''), r.note);
  ok('warns against substituting a violator',
    r.warnings.some((w) => /NEVER substitute/.test(w)), JSON.stringify(r.warnings));
}

// ------------------------------------- absence is not evidence (D2)
/* A title regex for "wire" found nothing and that was reported as "wired 9V
 * modules do not exist". Titles omit physical attributes. The warning fires
 * in-band, where the false conclusion gets drawn.
 */
console.log('\nrank — a collapsed title filter is NOT evidence of absence');
{
  const pool = Array.from({ length: 30 }, (_, n) => ({
    id: 'i' + n, title: 'ac dc power module 9v', rating: 4.8, sold: 500, reviews: 80,
  }));
  const r = rank(pool, ['--mode', 'final', '--top', '4', '--require', 'wire|כבל']);
  eq('title filter really did collapse the pool', r.ranked.length, 0);
  ok('absence warning is emitted',
    r.warnings.some((w) => /absence-is-not-evidence/.test(w)), JSON.stringify(r.warnings));
  ok('warning names the image/description check',
    r.warnings.some((w) => /listing\.js|labels\.sh|IMAGES/.test(w)), JSON.stringify(r.warnings));

  // A filter that keeps most of the pool must NOT cry wolf.
  const r2 = rank(pool, ['--mode', 'final', '--top', '4', '--require', 'module']);
  ok('no false alarm when the filter keeps the pool',
    !r2.warnings.some((w) => /absence-is-not-evidence/.test(w)), JSON.stringify(r2.warnings));
}

// ------------------------------------------------- listing.js (D3 + D4)
/* listing.js must (a) refuse to parse a wall, (b) return text AND images in
 * ONE call so they cannot drift apart, (c) see images that live behind a
 * shadow root, (d) tell you the page changed after expanding.
 */
console.log('\nlisting.js — text and images come back together, shadow DOM included');
{
  const listingSrc = RUN('listing.js');

  // Minimal DOM stub: enough for querySelectorAll('*'), shadowRoot, innerText.
  const mkEl = (tag, props = {}) => ({
    tagName: tag, children: props.children || [], childrenList: props.children || [],
    textContent: props.text || '', className: props.cls || '',
    naturalWidth: props.nw || 0, naturalHeight: props.nh || 0,
    currentSrc: props.src || '', src: props.src || '',
    shadowRoot: props.shadow || null,
    // The carton qualifier lives in a SIBLING, so the reader must consult the
    // parent's text — model that here or the regression cannot be caught.
    parentElement: props.parent || null,
    getAttribute: (k) => (props.attrs || {})[k] || null,
    // Option tiles hold their name in a child <img alt>; model that lookup.
    querySelector: (sel) => (sel === 'img'
      ? (props.children || []).find((c) => c.tagName === 'IMG') || null : null),
    // A container's own descendants, for walks that start below `document`.
    querySelectorAll: () => props.qsa || [],
    closest: () => null, click() { (props.onClick || (() => {}))(); },
    id: props.id || '',
    // The ancestor link the zone walk climbs from a shadow root to its host.
    getRootNode: props.rootHost ? () => ({ host: props.rootHost }) : undefined,
    // Child nodes in tree order, which textOf() recurses through (innerText
    // misses shadow content). `nodes` sets them exactly; otherwise the own
    // text comes first, then `kids`.
    nodeType: 1,
    childNodes: props.nodes || [...(props.text ? [{ nodeType: 3, nodeValue: props.text }] : []), ...(props.kids || [])],
  });
  const mkRoot = (els) => ({ querySelectorAll: () => els, childNodes: els });
  const txt = (s) => ({ nodeType: 3, nodeValue: s });

  const runListing = ({ href, bodyText, els, shadowEls = [], html = '', ldCount = null, win = {}, visibilityState }) => {
    const host = mkEl('DIV', { shadow: mkRoot(shadowEls) });
    const all = [...els, host];
    const document = {
      body: { scrollHeight: 5000, innerText: bodyText },
      documentElement: { outerHTML: html },
      visibilityState,
      // ldCount lets a test express "big page, zero JSON-LD" — the shape of
      // the quiet wall that walked through the old boolean check.
      querySelectorAll: (sel) =>
        (ldCount !== null && /ld\+json/.test(sel || '')) ? new Array(ldCount) : all,
    };
    const sandbox = {
      window: { scrollTo() {}, ...win }, document, location: { href },
      console,
    };
    sandbox.window.document = document;
    const fn = new Function('window', 'document', 'location',
      `${listingSrc}; return window.__aeListing;`);
    return fn(sandbox.window, document, sandbox.location);
  };

  // (a) the wall must be detected before anything is parsed
  const blockedApi = runListing({
    href: 'https://he.aliexpress.com/_____tmd_____/punish?x5secdata=abc',
    bodyText: 'Sorry, we have detected unusual traffic', els: [],
  });
  const blockedRes = await blockedApi.read();
  ok('listing.js reports a wall as blocked, not as empty data', blockedRes.blocked === true);
  ok('blocked result tells the operator to stop this turn',
    /STOP and tell the user/.test(blockedRes.note || ''), blockedRes.note);

  // (b)+(c) text and images in one call, image hidden behind a shadow root
  // The gallery lives in a shadow root under the main-image container.
  const mainWrap = mkEl('DIV', { cls: 'main-image--wrap--AbC12x' });
  const shadowImg = mkEl('IMG', {
    src: 'https://ae-pic-a1.aliexpress-media.com/kf/Sbig.jpg', nw: 800, nh: 800, rootHost: mainWrap,
  });
  const api = runListing({
    href: 'https://he.aliexpress.com/item/123.html',
    bodyText: 'גודל: 8 ס"מ x 3.7 ס"מ x 2 ס"מ OUTPUT:9V1.6A',
    els: [
      mkEl('SPAN', { text: 'גודל: 8 ס"מ x 3.7 ס"מ x 2 ס"מ' }),
      mkEl('SPAN', { text: 'OUTPUT:9V1.6A' }),
      // The real page renders the carton size as a BARE leaf whose qualifier
      // sits in the parent. Testing the leaf alone missed it on the live site.
      mkEl('SPAN', {
        text: '12×7×4 סמ',
        parent: { textContent: 'גודל החבילה: 12×7×4 סמ, משקל: 0.059 קג' },
      }),
      mkEl('IMG', { src: 'https://ae-pic-a1.aliexpress-media.com/kf/Sicon.png', nw: 27, nh: 27 }),
    ],
    shadowEls: [shadowImg],
  });
  const res = await api.read();
  ok('image behind a shadow root IS found (bare querySelectorAll returns 1)',
    res.gallery.some((u) => /Sbig\.jpg/.test(u)), JSON.stringify(res.gallery));
  eq('the zone walk crosses the shadow root to the product container', res.galleryScope, 'product');
  ok('27x27 icons are not mistaken for product images',
    !res.gallery.some((u) => /Sicon/.test(u)), JSON.stringify(res.gallery));
  ok('the SAME call also returns the size line', res.sizeLines.length > 0,
    JSON.stringify(res.sizeLines));
  ok('the size line that was missed is captured',
    res.sizeLines.some((s) => /8 ס"מ x 3\.7/.test(s.text)), JSON.stringify(res.sizeLines));
  ok('carton size is identified via the PARENT text, not the leaf',
    res.packageSizeLines.some((t) => /12×7×4/.test(t)), JSON.stringify(res.packageSizeLines));
  ok('carton size is kept OUT of the product sizes',
    !res.productSizeLines.some((t) => /12×7×4/.test(t)), JSON.stringify(res.productSizeLines));
  ok('the real product size IS in productSizeLines',
    res.productSizeLines.some((t) => /8 ס"מ x 3\.7/.test(t)), JSON.stringify(res.productSizeLines));
  ok('the electrical rating line is captured',
    res.ratingLines.some((t) => /9V1\.6A/.test(t)), JSON.stringify(res.ratingLines));
  ok('read() reminds that the photo label outranks text fields',
    /outrank/.test(res.reminder || ''), res.reminder);
  ok('text and images arrive in ONE result object',
    typeof res.text === 'string' && Array.isArray(res.gallery));

  // (d) a mutation must be detectable
  ok('changed() reports true against a stale fingerprint',
    api.changed({ height: 1, textLen: 1, imgs: 0, leaves: 0 }) === true);
  ok('changed() reports false against a current fingerprint',
    api.changed(api.fingerprint()) === false);

  /* (e) options come from the OPTION SELECTOR, never from reviews
   * (measured 2026-09-25). The old walk took any class containing "sku": it
   * missed the image options entirely and returned the variant line of a
   * review of another seller's item. Class names are the live ones. */
  const optImg = (alt) => mkEl('IMG', { attrs: { alt }, nw: 60, nh: 60,
    src: 'https://ae-pic-a1.aliexpress-media.com/kf/S' + alt + '.jpg' });
  const white = optImg('White');
  const black = optImg('Black');
  const optApi = runListing({
    href: 'https://he.aliexpress.com/item/1005010285456577.html',
    bodyText: 'One/Nine-key Keychain 4.9 4026 Reviews ౹ 50,000+ sold US $2.14 Reviews (4026) ' +
      'Reviews | 4.9 952 ratings All from verified purchases All ratings (223) ' +
      'Color:9 Key no light Ships From:China Mainland ' +
      'Reviews displayed are from various sellers for similar items on AliExpress. ' + 'x'.repeat(2500),
    els: [
      mkEl('DIV', { cls: 'sku-item--title--Z0HLO87', text: 'Color: White' }),
      mkEl('DIV', { cls: 'sku-item--image--jMUnnGA sku-item--selected--ITGY_EO', children: [white] }), white,
      mkEl('DIV', { cls: 'sku-item--image--jMUnnGA', children: [black] }), black,
      mkEl('DIV', { cls: 'sku-item--text--Qa1', text: '3Pcs Random Color' }),
      // The live leak was this short review line (under the old 40-char cap).
      mkEl('SPAN', { cls: 'list--itemSku--Zx9', text: 'Color:D Ships From:China Mainland' }),
    ],
  });
  const optRes = await optApi.read();
  eq('options are read from the option selector, in order', optRes.variants, ['White', 'Black', '3Pcs Random Color']);
  eq('the selected option is named', optRes.selectedVariant, 'White');
  ok('a review line of another seller\'s item is NOT an option',
    !optRes.variants.some((v) => /Ships From/.test(v)), JSON.stringify(optRes.variants));
  ok('the property title is NOT an option', !optRes.variants.includes('Color: White'), JSON.stringify(optRes.variants));
  eq('read() returns the own review count, not the pooled one',
    optRes.reviews, { own: 952, ownRating: 4.9, header: 4026, pooledNote: true });

  /* (f) THE GALLERY WAS OTHER PRODUCTS (measured 2026-09-29). Every image of
   * 400 px or more used to be "the gallery": for one listing 8 of 15 were
   * related items (slick-slide carousel), the footer licence badge, and
   * category menu icons. For another it kept 1 of 9 product photos and dropped 8,
   * because the slider serves them at 220 px. Class names are the live ones. */
  const CDN = 'https://ae-pic-a1.aliexpress-media.com/kf/';
  // chain(outermost, ..., innermost): returns the innermost, linked upward.
  const chain = (...classes) => classes.reduce((parent, cls) => mkEl('DIV', { cls, parent }), null);
  const pdp = chain('pdp-info-left--x', 'main-image--wrap--f1', 'image-view-v2--wrap--q', 'slider--wrap--z', 'slider--item--k');
  const slick = chain('_9HTSH', 'slick-track', 'slick-slide');
  const footer = chain('footer-copywrite', 'container');
  const menu = chain('Categoey--categoryContainer--a', 'Categoey--lv1Item--b');
  const zoneEls = [
    mkEl('IMG', { src: CDN + 'Sown1aaa.jpg_220x220q75.jpg_.avif', nw: 220, nh: 220, parent: pdp }),
    mkEl('IMG', { src: CDN + 'Sown2bbb.jpg_220x220q75.jpg_.avif', nw: 220, nh: 220, parent: pdp }),
    mkEl('IMG', { src: CDN + 'Sown1aaa.jpg_960x960q75.jpg_.avif', nw: 915, nh: 915, parent: pdp }),
    mkEl('IMG', { src: CDN + 'Sown3ccc.jpg_220x220q75.jpg_.avif?v=1', nw: 0, nh: 0, parent: pdp }),
    mkEl('IMG', { src: CDN + 'Splayicon.png_.avif', nw: 48, nh: 48, parent: pdp }),
    mkEl('IMG', { src: CDN + 'Srelated1.jpg', nw: 800, nh: 800, parent: slick }),
    mkEl('IMG', { src: CDN + 'Srelated2.jpg', nw: 800, nh: 800, parent: slick }),
    mkEl('IMG', { src: CDN + 'Slicence.png', nw: 1228, nh: 1228, parent: footer }),
    mkEl('IMG', { src: CDN + 'Smenuicon.png', nw: 1024, nh: 1024, parent: menu }),
  ];
  const zRes = await runListing({ href: 'https://he.aliexpress.com/item/1005007252144239.html',
    bodyText: 'x'.repeat(2500), els: zoneEls }).read();
  eq('the gallery is the product zone only, full size, slider order, deduped',
    zRes.gallery, [CDN + 'Sown1aaa.jpg', CDN + 'Sown2bbb.jpg', CDN + 'Sown3ccc.jpg']);
  eq('galleryScope says the product container was found', zRes.galleryScope, 'product');
  eq('other products are counted by zone, never returned as the product',
    zRes.excludedImages, { carousel: 2, footer: 1, menu: 1 });
  ok('a 48 px play icon in the product zone is not a product photo',
    !zRes.gallery.some((u) => /Splayicon/.test(u)), JSON.stringify(zRes.gallery));
  ok('an image not loaded yet (0 px) in the product zone is kept',
    zRes.gallery.includes(CDN + 'Sown3ccc.jpg'), JSON.stringify(zRes.gallery));
  ok('no gallery URL carries a query string (the Chrome connector blocks it)',
    !zRes.gallery.some((u) => u.includes('?')), JSON.stringify(zRes.gallery));
  ok('no unscoped warning when the container was found',
    !zRes.warnings.some((w) => /gallery-unscoped/.test(w)), JSON.stringify(zRes.warnings));

  // No product container at all: fall back to every big image, LOUDLY.
  const fbRes = await runListing({ href: 'https://he.aliexpress.com/item/1.html', bodyText: 'x'.repeat(2500),
    els: [mkEl('IMG', { src: CDN + 'Sloose.jpg', nw: 800, nh: 800 })] }).read();
  eq('without the container the gallery is unscoped', fbRes.galleryScope, 'unscoped');
  eq('the fallback still returns the big images', fbRes.gallery, [CDN + 'Sloose.jpg']);
  ok('and it says so in warnings', fbRes.warnings.some((w) => /gallery-unscoped/.test(w)), JSON.stringify(fbRes.warnings));

  /* (g) THE DESCRIPTION NEVER REACHED `text` (measured 2026-09-29). It
   * renders in a SHADOW ROOT under #nav-description, and `text` came from
   * body.innerText, which never includes shadow content: "Weight: about
   * 750 g" was on screen and absent from `text`. In a hidden tab the shadow
   * content is not rendered at all, although the page requested the
   * description document; fetching that URL returned 200 with the text and
   * 17 images. */
  const DESC_URL = 'https://pdp.aliexpress-media.com/product/description/pc/v2/en_US/desc.htm?productId=1&key=k&token=t';
  const descBody = 'Item type: 3 in 1 Rotary Cheese Grater Weight: about 680 g Package includes: 1 x grater';

  // (g1) rendered: the shadow tree under #nav-description holds it.
  const descBox = mkEl('DIV', { id: 'nav-description', cls: 'description--wrap--LscZ0He' });
  const shLeaf1 = mkEl('LI', { text: descBody });
  const shLeaf2 = mkEl('LI', { text: 'Size: 22 x 12 x 28 cm' });
  const shStyle = mkEl('STYLE', { text: '.product-description{width:960px;margin:0 auto}' });
  const shHost = mkEl('DIV', { id: 'product-description', parent: descBox,
    shadow: mkRoot([shStyle, shLeaf1, shLeaf2]) });
  const shImg = mkEl('IMG', { src: CDN + 'Sdrawing1.jpg_960x960.jpg', nw: 750, nh: 1200, rootHost: shHost });
  shHost.shadowRoot = mkRoot([shStyle, shLeaf1, shLeaf2, shImg]);
  descBox.querySelectorAll = () => [shHost];
  descBox.childNodes = [shHost];
  let fetches = 0;
  const rRes = await runListing({ href: 'https://he.aliexpress.com/item/1.html', bodyText: 'x'.repeat(2500),
    els: [descBox, shHost], win: { fetch: async () => { fetches++; return {}; } } }).read();
  eq('a rendered description is read from its shadow tree', rRes.description.source, 'rendered');
  ok('its text reaches `text` (body.innerText never had it)', /\[DESCRIPTION\].*Weight: about 680 g/.test(rRes.text),
    rRes.text.slice(-160));
  ok('the shadow root\'s CSS is not product text', !/margin:0 auto/.test(rRes.text), rRes.text.slice(-160));
  ok('its size line reaches sizeLines', rRes.productSizeLines.some((t) => /22 x 12 x 28 cm/.test(t)),
    JSON.stringify(rRes.productSizeLines));
  eq('its images are the descriptionImages, at full size', rRes.descriptionImages, [CDN + 'Sdrawing1.jpg']);
  eq('a rendered description counts its images (review finding F11)', rRes.description.imageCount, 1);
  eq('a rendered description costs no request', fetches, 0);

  /* (g1b) TEXT ORDER (review finding F7, confirmed in real Chromium). Taking
   * each element's own text nodes in querySelectorAll order read
   * "<li><b>Weight:</b> about 680 g</li>" as "about 680 g Weight:", because
   * the <li> is listed before the <b>. The walk must follow tree order. */
  const ordBold = mkEl('B', { text: 'Weight:' });
  const ordLi = mkEl('LI', { nodes: [ordBold, txt(' about 680 g')] });
  const ordLi2 = mkEl('LI', { nodes: [mkEl('B', { text: 'Material:' }), txt(' Stainless Steel & PP, easy to clean and safe')] });
  const ordBox = mkEl('DIV', { id: 'nav-description' });
  const ordHost = mkEl('DIV', { parent: ordBox, shadow: mkRoot([ordLi, ordLi2]) });
  ordBox.childNodes = [ordHost];
  ordBox.querySelectorAll = () => [ordHost, ordBold];
  const oRes = await runListing({ href: 'https://he.aliexpress.com/item/1.html', bodyText: 'x'.repeat(2500),
    els: [ordBox, ordHost] }).read();
  ok('a bold label stays before its value', /Weight: about 680 g/.test(oRes.text), oRes.text.slice(-120));
  ok('two list items do not run together', /680 g Material:/.test(oRes.text), oRes.text.slice(-120));

  // (g2) hidden tab: nothing rendered under #nav-description (only the empty
  // iframe the page keeps there), so the description is fetched from the URL
  // the page already requested.
  const emptyBox = mkEl('DIV', { id: 'nav-description', qsa: [mkEl('IFRAME', {})] });
  const parsedLeaf = mkEl('LI', { text: 'Size: 30 x 15 x 25 cm' });
  const parsedText = mkEl('P', { text: descBody });
  const parsedCss = mkEl('STYLE', { text: 'body{font-size:14px}' });
  const parsedImg = mkEl('IMG', { attrs: { src: '//ae-pic-a1.aliexpress-media.com/kf/Sspec2.jpg_640x640.jpg' } });
  const fetchedUrls = [];
  const win = {
    performance: { getEntriesByType: () => [{ name: 'https://x.alicdn.com/other.js' }, { name: DESC_URL }] },
    fetch: async (u) => { fetchedUrls.push(u); return { url: u, text: async () => '<html>' + descBody + '</html>' }; },
    DOMParser: class { parseFromString() { return {
      body: mkEl('BODY', { qsa: [parsedCss, parsedText, parsedLeaf, parsedImg], kids: [parsedCss, parsedText, parsedLeaf, parsedImg] }),
      querySelectorAll: () => [parsedCss, parsedText, parsedLeaf, parsedImg] }; } },
  };
  const hRes = await runListing({ href: 'https://he.aliexpress.com/item/1.html', bodyText: 'x'.repeat(2500),
    els: [emptyBox], win, visibilityState: 'hidden' }).read();
  eq('an unrendered description makes read() fetch it', hRes.description.source, 'fetched');
  ok('the fetched document\'s CSS is not product text', !/font-size/.test(hRes.text), hRes.text.slice(-160));
  eq('from the URL the page itself requested', fetchedUrls, [DESC_URL]);
  ok('the fetched text reaches `text`', /\[DESCRIPTION\].*Weight: about 680 g/.test(hRes.text), hRes.text.slice(-160));
  ok('the fetched size line reaches sizeLines', hRes.productSizeLines.some((t) => /30 x 15 x 25 cm/.test(t)),
    JSON.stringify(hRes.productSizeLines));
  eq('fetched description images come back full size', hRes.descriptionImages, [CDN + 'Sspec2.jpg']);
  ok('nothing in the result carries the description query string',
    !JSON.stringify(hRes).includes('token='), 'query string leaked');
  eq('the tab is reported hidden', hRes.visibility, 'hidden');
  ok('and read() warns what that breaks', hRes.warnings.some((w) => /tab-hidden/.test(w)), JSON.stringify(hRes.warnings));

  // (g3) nothing to read: unknown, never "the listing states nothing".
  const mRes = await runListing({ href: 'https://he.aliexpress.com/item/1.html', bodyText: 'x'.repeat(2500),
    els: [] }).read();
  eq('no rendered text and no request: source is missing', mRes.description.source, 'missing');
  ok('missing is a warning, not silence', mRes.warnings.some((w) => /description-missing.*Do NOT report/.test(w)),
    JSON.stringify(mRes.warnings));
  const fRes = await runListing({ href: 'https://he.aliexpress.com/item/1.html', bodyText: 'x'.repeat(2500), els: [],
    win: { performance: { getEntriesByType: () => [{ name: DESC_URL }] }, fetch: async () => { throw new Error('net'); } } }).read();
  eq('a failed fetch is named', fRes.description.source, 'fetch-failed');
  ok('and warned about', fRes.warnings.some((w) => /description-fetch-failed/.test(w)), JSON.stringify(fRes.warnings));
  eq('a visible-state-less stub reports unknown, not visible', fRes.visibility, 'unknown');

  const fetchedWin = (body, url, extra = {}) => ({
    performance: { getEntriesByType: () => [{ name: DESC_URL }] },
    fetch: async () => ({ url: url || DESC_URL, text: async () => '<html>' + body + '</html>' }),
    DOMParser: class { parseFromString() { const p = mkEl('P', { text: body });
      return { body: mkEl('BODY', { qsa: [p], kids: [p] }), querySelectorAll: () => [p] }; } },
    ...extra,
  });

  /* (g4) review finding F0: seller copy that happens to contain a wall
   * phrase is the description, not a wall. */
  const slideBody = 'Please slide the drum into the holder until it clicks. Weight: about 680 g. Package includes 3 drums.';
  const sRes = await runListing({ href: 'https://he.aliexpress.com/item/1.html', bodyText: 'x'.repeat(2500), els: [],
    win: fetchedWin(slideBody) }).read();
  eq('a description saying "please slide" is still fetched', sRes.description.source, 'fetched');
  ok('and its text is kept', /Please slide the drum/.test(sRes.text), sRes.text.slice(-140));
  eq('and it raises no wall', sRes.blocked, false);

  /* (g5) review finding F1: a REAL wall on the description fetch must stop
   * the run like a page wall, not pass as "description unknown". */
  const wRes = await runListing({ href: 'https://he.aliexpress.com/item/1.html', bodyText: 'x'.repeat(2500), els: [],
    win: fetchedWin('Sorry, we have detected unusual traffic. Please slide to verify',
      'https://he.aliexpress.com/_____tmd_____/punish') }).read();
  eq('a wall on the description fetch is named', wRes.description.source, 'blocked');
  eq('and raised to the top-level blocked flag', wRes.blocked, true);
  ok('with the STOP instruction', wRes.warnings.some((w) => /STOP and tell the user/.test(w)), JSON.stringify(wRes.warnings));
  ok('while the rest of the read is still returned', wRes.gallery !== undefined && wRes.reviews !== undefined);
  const qRes = await runListing({ href: 'https://he.aliexpress.com/item/1.html', bodyText: 'x'.repeat(2500), els: [],
    win: fetchedWin('', DESC_URL, { fetch: async () => ({ url: DESC_URL, text: async () => '<html><!-- punish ' + 'y'.repeat(60000) + ' --></html>' }) }) }).read();
  eq('a quiet wall on the description fetch is a suspect-wall', qRes.description.source, 'suspect-wall');
  eq('raised as suspectedWall, not blocked', [qRes.blocked, qRes.suspectedWall], [false, true]);

  /* (g6) review findings F2/F8: a description fetch that never settles used
   * to lose the whole read. The complete result without the description is
   * stored in `last` BEFORE the fetch; read({ description: false }) skips it. */
  const hangApi = runListing({ href: 'https://he.aliexpress.com/item/1.html', bodyText: 'x'.repeat(2500), els: zoneEls,
    win: { performance: { getEntriesByType: () => [{ name: DESC_URL }] }, fetch: () => new Promise(() => {}) } });
  const hanging = hangApi.read();
  await new Promise((r) => setImmediate(r));
  ok('read() is still waiting on the fetch', hangApi.last !== null);
  eq('`last` already holds the result, marked pending', hangApi.last.description.source, 'pending');
  eq('with the gallery already in it', hangApi.last.galleryCount, 3);
  ok('and a warning naming `last`', hangApi.last.warnings.some((w) => /description-pending.*__aeListing\.last/.test(w)),
    JSON.stringify(hangApi.last.warnings));
  void hanging;
  let skipFetches = 0;
  const kRes = await runListing({ href: 'https://he.aliexpress.com/item/1.html', bodyText: 'x'.repeat(2500), els: [],
    win: { performance: { getEntriesByType: () => [{ name: DESC_URL }] }, fetch: async () => { skipFetches++; return {}; } } })
    .read({ description: false });
  eq('description:false never fetches', skipFetches, 0);
  eq('and names the description skipped', kRes.description.source, 'skipped');
  ok('which is a warning, not silence', kRes.warnings.some((w) => /description-skipped.*Do NOT report/.test(w)),
    JSON.stringify(kRes.warnings));
}

// ------------------------------------------ two browsers, two locales (2026-09-14)
/* A signed-in account renders its own locale: the same item that reads
 * "1,000+ נמכרו" logged out reads "10,000+ sold" for a USD/English account,
 * and grid prices come back as USD. The harvester must parse both without
 * being told which browser it is in — nobody flips a flag correctly every
 * time, and a wrong flag means every sold count silently parses to null.
 */
console.log('\nharvest.js — English pages parse like Hebrew ones');
{
  const enItem = (id, sold, price, cur) => ({
    productId: id, title: { displayTitle: 'Disposable Dry Sweeping Cloths ' + id },
    prices: { salePrice: { minPrice: price, discount: 50, currencyCode: cur }, originalPrice: { minPrice: 9.9 } },
    evaluation: { starRating: 4.9 }, trade: { tradeDesc: sold + ' sold' },
  });
  const H = loadHarvest(async () => reply(makePage({
    items: [enItem('en1', '10,000+', 4.92, 'USD'), enItem('en2', '4.000+', 3.1, 'USD'),
            makeItem('he1', { soldRaw: '1,000+', price: 6.38 })],
    finished: true,
  })));
  H.start({ query: 'electrostatic dust cloth' });
  await H.step(1);
  const by = Object.fromEntries(JSON.parse(H.payload()).items.map((i) => [i.id, i]));
  eq('"10,000+ sold" parses', by.en1.sold, 10000);
  eq('"4.000+ sold" parses (dot thousands, English marker)', by.en2.sold, 4000);
  eq('"1,000+ נמכרו" still parses', by.he1.sold, 1000);
  eq('currency recorded from the grid payload', by.en1.currency, 'USD');
  eq('currency is null when the payload has none', by.he1.currency, null);
}

console.log('\nharvest.js — forceEnglish() writes the three locale cookies (in-app browser only)');
{
  const jar = [];
  const fakeWin = { document: { set cookie(v) { jar.push(v); }, get cookie() { return jar.join('; '); } } };
  // harvest.js reads window.document; give the fake window one.
  const src = RUN('harvest.js');
  new Function('window', 'fetch', src)(fakeWin, async () => reply(makePage()));
  const msg = fakeWin.__aeHarvest.forceEnglish();
  ok('three cookies written', jar.length === 3, JSON.stringify(jar));
  ok('locale cookie asks for en_US', jar.some((c) => /^aep_usuc_f=.*b_locale=en_US/.test(c)), jar[0]);
  ok('default currency/region are ILS/IL', /c_tp=ILS&region=IL/.test(jar[0]), jar[0]);
  ok('cookies are scoped to .aliexpress.com', jar.every((c) => /domain=\.aliexpress\.com/.test(c)));
  const jar2 = []; const win2 = { document: { set cookie(v) { jar2.push(v); } } };
  new Function('window', 'fetch', src)(win2, async () => reply(makePage()));
  win2.__aeHarvest.forceEnglish({ currency: 'USD', region: 'US' });
  ok('currency and region are parameters', /c_tp=USD&region=US/.test(jar2[0]), jar2[0]);
  ok('return text does not echo a cookie value', !/aep_usuc_f|b_locale/.test(msg), msg);
}

/* WHY expose() EXISTS (measured 2026-09-14). The Chrome connector's
 * javascript_tool returns at most 1,000 characters, so payload() (90 KB per
 * 400 items) can never come back through it. get_page_text returns up to
 * 50,000 characters of page text, so the payload is written into a <pre>
 * placed FIRST in <body> — page text after it may be cut, the chunk is not —
 * and read back one chunk at a time. */
console.log('\nharvest.js — expose() chunks the payload into the page for get_page_text');
{
  const src = RUN('harvest.js');
  const els = {};
  const body = { children: [], get firstChild() { return this.children[0] || null; },
    insertBefore(el, ref) { this.children = [el, ...this.children.filter((c) => c !== el)]; return el; } };
  const doc = {
    body,
    getElementById: (id) => els[id] || null,
    createElement: (tag) => { const el = { tag, id: '', textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
      // register lazily so a second expose() finds the same element
      Object.defineProperty(el, 'id', { set(v) { els[v] = el; el._id = v; }, get() { return el._id; } });
      return el; },
  };
  const win = { document: doc };
  new Function('window', 'fetch', src)(win, async () => reply(makePage({
    items: Array.from({ length: 40 }, (_, i) => makeItem('big' + i, { title: 'x'.repeat(120) })), finished: true,
  })));
  const H = win.__aeHarvest;
  H.start({ query: 'wire brush set' });
  await H.step(1);
  const full = H.payload();
  const info = H.chunks(3000);
  ok('chunks() reports total, size and count', info.total === full.length && info.count === Math.ceil(full.length / 3000), JSON.stringify(info));
  const msgs = [];
  for (let i = 0; i < info.count; i++) {
    const msg = H.expose(i, 3000);
    msgs.push(msg);
    const pre = els.__aePayload;
    ok(`chunk ${i} lands in a <pre> that is the first child of body`, body.children[0] === pre);
    ok(`chunk ${i} is wrapped in markers`, new RegExp(`^AEPAYLOAD ${i}/${info.count} [0-9a-z]+ START\\n[\\s\\S]*\\nAEPAYLOAD END$`).test(pre.textContent));
  }
  ok('expose() return text is short enough for the 1,000-char cap', msgs.every((m) => m.length < 200));
  ok('one <pre> is reused, not one per chunk', body.children.length === 1);
}

// ------------------------------------------------- send() + receiver.mjs
/* The primary export: the page POSTs the payload to a loopback receiver that
 * writes it to disk. Tested end to end — the real receiver on an ephemeral
 * port, the real send() with Node's fetch — not a mocked pair. */
console.log('\nharvest.js send() + receiver.mjs — payload lands on disk, both ends real');
{
  const { startReceiver, validate } = await import('./receiver.mjs');
  const { mkdtempSync, readdirSync, readFileSync: rf } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'ae-recv-'));
  const logs = [];
  const recv = await startReceiver({ dir, port: 0, count: 1, idle: 30, log: (m) => logs.push(m) });
  ok('receiver picks an ephemeral port', recv.port > 0, String(recv.port));

  const src = RUN('harvest.js');
  const win = {};
  new Function('window', 'fetch', src)(win, async (url, init) => {
    if (typeof url === 'string' && url.startsWith('http://127.0.0.1:')) return fetch(url, init); // the real loopback POST
    return reply(makePage({ items: [makeItem('r1', { title: 'brush r1', soldRaw: '2,000+' })], finished: true }));
  });
  const H = win.__aeHarvest;
  H.start({ query: 'wire brush set' });
  await H.step(1);
  const msg = await H.send(recv.port);
  ok('send() reports the receiver reply', /receiver replied 200: saved /.test(msg), msg);
  ok('send() reply carries no query string', !msg.includes('?'), msg);
  ok('send() reply is under the 1,000-char Chrome cap', msg.length < 400, String(msg.length));
  const files = readdirSync(dir).filter((f) => f.startsWith('harvest-wire-brush-set-') && f.endsWith('.json'));
  eq('one file written, named after the query', files.length, 1);
  eq('file content is the payload byte for byte', rf(join(dir, files[0]), 'utf8'), H.payload());
  await new Promise((r) => setTimeout(r, 120));
  ok('receiver closed itself after --count payloads', recv.server.listening === false);

  eq('garbage is rejected before touching disk', validate('nope').err, 'body is not JSON');
  eq('JSON without items[] is rejected', validate('{"a":1}').err, 'JSON has no items[] — not a payload');

  /* Chrome 153 holds a fetch() from a public https page to loopback behind
   * its local-network permission (the request never arrived in 45 s), while
   * a top-level form POST arrives. So send() races fetch against a timeout
   * and falls back to a text/plain form, whose body reaches the receiver as
   * "payload=<json>\r\n" — unwrap() must strip that, and only that. */
  const { unwrap } = await import('./receiver.mjs');
  eq('form-encoded body is unwrapped', unwrap('payload={"query":"x","items":[]}\r\n'), '{"query":"x","items":[]}');
  eq('raw JSON is left alone', unwrap('{"a":"b=c","items":[]}'), '{"a":"b=c","items":[]}');
  eq('an = inside the JSON is not the wrapper', unwrap('payload={"a":"b=c"}'), '{"a":"b=c"}');
  {
    const recvF = await startReceiver({ dir, port: 0, count: 1, idle: 30 });
    const formBody = 'payload=' + H.payload() + '\r\n';
    const r = await fetch('http://127.0.0.1:' + recvF.port + '/harvest', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: formBody });
    eq('form-encoded POST is accepted', r.status, 200);
    const saved = readdirSync(dir).filter((f) => f.startsWith('harvest-wire-brush-set-')).sort();
    eq('form-encoded POST is saved as bare JSON', rf(join(dir, saved[saved.length - 1]), 'utf8'), H.payload());
    await new Promise((r2) => setTimeout(r2, 120));
  }
  {
    // send(): a held fetch falls back to the form; a working fetch does not.
    const forms = [];
    const doc = { createElement: (tag) => ({ tag, appendChild(c) { (this.children = this.children || []).push(c); }, submit() { this.submitted = true; forms.push(this); } }),
      body: { appendChild() {} } };
    const winHeld = { document: doc, localStorage: fakeStorage() };
    new Function('window', 'fetch', src)(winHeld, (url) => url.startsWith('http://127.0.0.1:') ? new Promise(() => {}) : Promise.resolve(reply(makePage({ items: [makeItem('h1')], finished: true }))));
    winHeld.__aeHarvest.start({ query: 'wire brush set' });
    await winHeld.__aeHarvest.step(1);
    const msg2 = await winHeld.__aeHarvest.send(9999, { timeoutMs: 50 });
    ok('a held fetch falls back to a form POST, reported as UNCONFIRMED', /^UNCONFIRMED: form-posted /.test(msg2), msg2);
    eq('the form targets the receiver URL', forms[0].action, 'http://127.0.0.1:9999/harvest');
    eq('the form is text/plain (no preflight, one field)', forms[0].enctype, 'text/plain');
    eq('the textarea carries the payload verbatim', forms[0].children[0].value, winHeld.__aeHarvest.payload());
    ok('the form was submitted', forms[0].submitted === true);
    ok('form reply names the next two steps', /get_page_text.*navigate back/.test(msg2), msg2);
    const winOk = { document: doc };
    new Function('window', 'fetch', src)(winOk, (url, init) => url.startsWith('http://127.0.0.1:')
      ? Promise.resolve({ status: 200, text: async () => 'saved /tmp/x.json' })
      : Promise.resolve(reply(makePage({ items: [makeItem('h2')], finished: true }))));
    winOk.__aeHarvest.start({ query: 'wire brush set' });
    await winOk.__aeHarvest.step(1);
    const msg3 = await winOk.__aeHarvest.send(9999, { timeoutMs: 50 });
    ok('a working fetch returns the reply and posts no form', /receiver replied 200: saved/.test(msg3) && forms.length === 1, msg3);

    /* A HIDDEN tab must not start the fetch race: the race needs a timer,
     * and a hidden tab delayed a 2,500 ms timer past the 45 s tool limit
     * (measured 2026-09-29). The form POST needs no timer. The loopback
     * fetch here would succeed, so if send() raced at all, it would return
     * the fetch reply and post no form: both halves are asserted. */
    const hiddenDoc = { ...doc, visibilityState: 'hidden' };
    const winHidden = { document: hiddenDoc, localStorage: fakeStorage() };
    let loopbackCalls = 0;
    new Function('window', 'fetch', src)(winHidden, (url) => {
      if (url.startsWith('http://127.0.0.1:')) { loopbackCalls++; return Promise.resolve({ status: 200, text: async () => 'saved /tmp/y.json' }); }
      return Promise.resolve(reply(makePage({ items: [makeItem('h3')] })));
    });
    winHidden.__aeHarvest.start({ query: 'wire brush set' });
    await winHidden.__aeHarvest.step(1);
    const msg4 = await winHidden.__aeHarvest.send(9999);
    eq('a hidden tab never calls the loopback fetch', loopbackCalls, 0);
    ok('a hidden tab posts the form straight away', /^UNCONFIRMED: form-posted /.test(msg4) && forms.length === 2, msg4);
    ok('the reply says why the fetch was skipped', /tab hidden: fetch skipped/.test(msg4), msg4);
    ok('the reply points at the receiver output, not get_page_text',
      /receiver prints "saved <path>" in its own output/.test(msg4) && /get_page_text hangs/.test(msg4), msg4);
    const msg5 = await winHidden.__aeHarvest.send(9999, { via: 'fetch' });
    ok('an explicit via:"fetch" is still honoured in a hidden tab', /receiver replied 200/.test(msg5) && loopbackCalls === 1, msg5);
  }
  const recv2 = await startReceiver({ dir, port: 0, count: 1, idle: 30 });
  const bad = await fetch('http://127.0.0.1:' + recv2.port + '/harvest', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"a":1}' });
  eq('receiver answers 400 to a non-payload', bad.status, 400);
  const pre = await fetch('http://127.0.0.1:' + recv2.port + '/harvest', { method: 'OPTIONS' });
  eq('CORS preflight answered', pre.status, 204);
  eq('CORS origin header present', pre.headers.get('access-control-allow-origin'), '*');
  await recv2.close();
}

// ---------------------------------------------------------------- decode.mjs
/* decode.mjs reassembles the payload from either channel. It is the ONLY
 * decoder — the inline snippet SKILL.md used to carry was retyped by hand
 * every run, which is how the double-encoding got mis-parsed. */
console.log('\ndecode.mjs — one decoder for the in-app file and the Chrome chunks');
{
  const { assemble, textsOf } = await import('./decode.mjs');
  const src = RUN('harvest.js');
  const els = {};
  const body = { children: [], get firstChild() { return this.children[0] || null; },
    insertBefore(el) { this.children = [el]; return el; } };
  const doc = { body, getElementById: (id) => els[id] || null,
    createElement: () => { const el = { textContent: '', setAttribute() {} };
      Object.defineProperty(el, 'id', { set(v) { els[v] = el; }, get() { return '__aePayload'; } }); return el; } };
  const win = { document: doc };
  new Function('window', 'fetch', src)(win, async () => reply(makePage({
    items: Array.from({ length: 12 }, (_, i) => makeItem('dec' + i, { title: 'brush ' + 'y'.repeat(80) })), finished: true,
  })));
  const H = win.__aeHarvest;
  H.start({ query: 'wire brush set' });
  await H.step(1);
  const payload = H.payload();

  // Channel 1: the in-app harness file — a JSON array of {type,text} where the
  // text is the JSON *string* returned by payload() (double-encoded).
  const inApp = JSON.stringify([{ type: 'text', text: 'aeHarvest ready' }, { type: 'text', text: JSON.stringify(payload) }]);
  const r1 = assemble(textsOf(inApp));
  eq('in-app file decodes to the payload', JSON.stringify(r1.payload), payload);
  eq('in-app channel named', r1.via, 'in-app-file');

  // Channel 2: Chrome get_page_text dumps, one per chunk, in the wrong order,
  // each surrounded by unrelated page text — as the real tool returns them.
  const n = H.chunks(2000).count;
  ok('fixture needs several chunks to be a real test', n >= 3, String(n));
  const dumps = [];
  for (let i = 0; i < n; i++) { H.expose(i, 2000); dumps.push('Title: x\nURL: y\n---\n' + els.__aePayload.textContent + '\nAliExpress footer'); }
  const r2 = assemble([dumps[2], dumps[0], ...dumps.slice(3), dumps[1]]);
  eq('chunks reassemble in order regardless of arrival order', JSON.stringify(r2.payload), payload);
  eq('chunk channel named with the count', r2.via, `page-text-chunks(${n})`);
  let err = null;
  try { assemble(dumps.slice(1)); } catch (e) { err = e.message; }
  ok('a missing chunk is an error that names it', /missing chunk\(s\) 0/.test(err || ''), err);

  // Channel 3: a plain payload file passes through.
  const r3 = assemble([payload]);
  eq('plain payload passes through', r3.via, 'plain-json');
  let err2 = null;
  try { assemble(['nothing useful here']); } catch (e) { err2 = e.message; }
  ok('garbage is refused, not returned as an empty payload', /no payload found/.test(err2 || ''), err2);
}

// ------------------------------------------- extract.js on an English page
console.log('\nextract.js — English grid, USD prices, path-only URL');
{
  const extractSrc = RUN('extract.js');
  // extract.js is a bare IIFE expression; wrap it in parentheses so the leading
  // comment's newlines cannot trigger ASI after `return`.
  const run = (win, doc, loc) => JSON.parse(new Function('window', 'document', 'location', 'return (' + extractSrc + '\n)')(win, doc, loc));
  const card = (id, text) => ({ href: 'https://he.aliexpress.com/item/' + id + '.html', parentElement: { parentElement: null, textContent: text } });
  const domDoc = (cards) => ({
    querySelectorAll: (sel) => /ld\+json/.test(sel) ? [] : cards,
    body: { innerText: 'grid page ' + 'x'.repeat(3000) }, documentElement: { outerHTML: '<html>grid</html>' }, title: 't',
  });
  const loc = { href: 'https://he.aliexpress.com/w/wholesale-clip-flat-mop.html?SortType=total_tranpro_desc&page=2',
    origin: 'https://he.aliexpress.com', pathname: '/w/wholesale-clip-flat-mop.html', search: '?SortType=total_tranpro_desc&page=2' };
  // init-data path with an English payload
  const win = { _dida_config_: { _init_data_: { data: { data: { root: { fields: { mods: { itemList: { content: [
    { productId: 'e1', title: { displayTitle: 'Clip Flat Mop 25cm' }, prices: { salePrice: { minPrice: 9.5, discount: 40, currencyCode: 'USD' }, originalPrice: { minPrice: 15 } },
      evaluation: { starRating: 4.8 }, trade: { tradeDesc: '3,000+ sold' } },
  ] } } } } } } } } };
  const r = run(win, domDoc([]), loc);
  eq('init-data: English sold parses', r.items[0].sold, 3000);
  eq('init-data: currency carried', r.items[0].currency, 'USD');
  eq('page number still read from the query', r.page, 2);
  ok('returned url has no query string (Chrome connector would block it)', !r.url.includes('?'), r.url);
  // DOM fallback with an English card: "4.8 1,000+ sold US $4.92 US $9.90 Free shipping"
  const r2 = run({}, domDoc([card('1005000000000001', 'Automatic Cloth Clip Mop 69.5cm 4.81,000+ sold US $4.92 US $9.90 -50% Free shipping')]), loc);
  eq('dom fallback used', r2.source, 'dom');
  eq('dom: rating split from glued sold (English)', r2.items[0].rating, 4.8);
  eq('dom: English sold parses', r2.items[0].sold, 1000);
  eq('dom: USD price read', r2.items[0].price, 4.92);
  eq('dom: original price read', r2.items[0].wasPrice, 9.9);
  eq('dom: currency from the symbol', r2.items[0].currency, 'USD');
  eq('dom: discount read from "-50%"', r2.items[0].discountPct, 50);
  ok('dom: free shipping detected in English', r2.items[0].freeShipping === true);
  const r3 = run({}, domDoc([card('1005000000000002', 'מגב שטוח עם קליפס 4.9 2,000+ נמכרו ₪18.30 ₪36.60 50%- משלוח חינם')]), loc);
  eq('dom: Hebrew card still parses (sold)', r3.items[0].sold, 2000);
  eq('dom: Hebrew card still parses (price)', r3.items[0].price, 18.3);
  eq('dom: Hebrew card currency', r3.items[0].currency, 'ILS');
  // "100K+ sold" (measured 2026-09-25) on both extract.js paths
  const winK = { _dida_config_: { _init_data_: { data: { data: { root: { fields: { mods: { itemList: { content: [
    { productId: 'k1', title: { displayTitle: 'Glitter Dumpling Squishy' }, prices: { salePrice: { minPrice: 2.48, currencyCode: 'USD' } },
      evaluation: { starRating: 4.9 }, trade: { tradeDesc: '100K+ sold' } },
    { productId: 'k2', title: { displayTitle: 'Odd Squishy' }, prices: { salePrice: { minPrice: 1, currencyCode: 'USD' } },
      evaluation: { starRating: 4.9 }, trade: { tradeDesc: 'lots sold' } },
  ] } } } } } } } } };
  const rK = run(winK, domDoc([]), loc);
  eq('init-data: "100K+ sold" parses', rK.items[0].sold, 100000);
  eq('init-data: unreadable sold text is kept', rK.items[1].soldText, 'lots sold');
  const rK2 = run({}, domDoc([card('1005012967864709', 'Glitter Dumpling Squishy with Box 4.9100K+ sold US $2.48 US $4.96 -50%')]), loc);
  eq('dom: rating split from glued "100K+ sold"', rK2.items[0].rating, 4.9);
  eq('dom: "100K+" parses', rK2.items[0].sold, 100000);
}

// ------------------------------------ own review count vs pooled (2026-09-25)
/* The JSON-LD reviewCount (= header "N Reviews" = "Reviews (N)" tab) is
 * usually POOLED across other sellers' similar items; the page says so. The
 * listing's own count is the review block "4.9 1090 ratings". Step 5 used to
 * rank on the pooled number: header 5,479 vs own 1,090 on one listing. The
 * texts below are copied from live pages read that day. */
console.log('\nparseReviewBlock — the header count is pooled; the review block is the listing\'s own');
const RV = {
  gyro: 'Metal Gyro 4.9 5479 Reviews ౹ 50,000+ sold US $1.58 50% offUS $3.16 Reviews (5479) Specifications ' +
        'Description More to love Reviews | 4.9 1090 ratings All from verified purchases All ratings (204) (29) ' +
        'Reviews displayed are from various sellers for similar items on AliExpress. View more',
  dumpling: 'Glitter Dumpling 4.9 4779 Reviews ౹ 100K+ sold US $2.48 50% offUS $4.96 Reviews (4779) ' +
        'Reviews | 4.9 488 ratings All from verified purchases All ratings (79) ' +
        'Reviews displayed are from various sellers for similar items on AliExpress.',
  boba: 'Boba Bottle 4.8 37 Reviews ౹ 455 sold US $11.35 Reviews (37) Reviews | 4.8 37 ratings All from verified purchases',
  comma: 'Reviews (9,460) Reviews | 4.9 1,914 ratings All from verified purchases',
  cardFirst: 'More to love Cute toy 4.7 12 ratings US $1.00 Reviews (5479) Reviews | 4.9 1090 ratings All from verified purchases',
  noBlock: '4.9 5479 Reviews ౹ 50,000+ sold',
  hebrew: '4.9 5479 חוות דעת ౹ 50,000+ נמכרו',
  empty: '',
};
eq('pooled listing: own 1090, header 5479, note seen', parseReviewBlock(RV.gyro), { own: 1090, ownRating: 4.9, header: 5479, pooledNote: true });
eq('pooled listing, 100K+: own 488', parseReviewBlock(RV.dumpling).own, 488);
eq('listing without the note: own equals header (37 = 37)', parseReviewBlock(RV.boba), { own: 37, ownRating: 4.8, header: 37, pooledNote: false });
eq('comma thousands in both numbers', [parseReviewBlock(RV.comma).own, parseReviewBlock(RV.comma).header], [1914, 9460]);
eq('a product card\'s "12 ratings" earlier on the page does not win', parseReviewBlock(RV.cardFirst).own, 1090);
eq('no review block: own is null (unknown), never the header', parseReviewBlock(RV.noBlock), { own: null, ownRating: null, header: 5479, pooledNote: false });
eq('Hebrew wording not observed yet: own is null', parseReviewBlock(RV.hebrew).own, null);
eq('empty text', parseReviewBlock(RV.empty), { own: null, ownRating: null, header: null, pooledNote: false });

/* The step-5 reader lives in SKILL.md as prose code. It is the code that ran
 * the pooled number into the ranking, so it is tested like code: pulled out
 * from between its markers and run against sample pages. */
const skillSrc = readFileSync(join(HERE, '..', 'SKILL.md'), 'utf8');
const step5 = (skillSrc.match(/<!-- @snippet:step5:start -->\s*```js\n([\s\S]*?)\n```\s*<!-- @snippet:step5:end -->/) || [])[1];
ok('SKILL.md carries the step-5 reader between its markers', !!step5);

console.log('\nshared blocks in listing.js and the SKILL.md step-5 reader — assert no copy has drifted');
for (const [name, src] of [['listing.js', readFileSync(join(HERE, 'listing.js'), 'utf8')], ['SKILL.md step 5', step5 || '']]) {
  const block = src.match(/\/\* @shared:reviewBlock:start \*\/([\s\S]*?)\/\* @shared:reviewBlock:end \*\//);
  ok(`${name} exposes the @shared:reviewBlock block`, !!block);
  if (!block) continue;
  const inlined = new Function(`${block[1]}; return parseReviewBlock;`)();
  const drift = Object.keys(RV).filter((k) => JSON.stringify(inlined(RV[k])) !== JSON.stringify(parseReviewBlock(RV[k])));
  ok(`${name} parseReviewBlock agrees with lib.mjs on every page text`, drift.length === 0, `drifted on ${JSON.stringify(drift)}`);
}
{
  const block = (step5 || '').match(/\/\* @shared:soldRe:start \*\/([\s\S]*?)\/\* @shared:soldRe:end \*\//);
  ok('SKILL.md step 5 exposes the @shared:soldRe block', !!block);
  if (block) {
    const re = new Function(`${block[1]}; return SOLD_RE;`)();
    eq('SKILL.md step 5 SOLD_RE is the lib.mjs pattern', [re.source, re.flags], [SOLD_RE.source, SOLD_RE.flags]);
  }
}

console.log('\nSKILL.md step-5 reader — run against sample detail pages');
{
  const opt = (name, { selected = false, image = true, cls = null } = {}) => ({
    className: cls || ((image ? 'sku-item--image--jMUnnGA' : 'sku-item--text--Qa1') + (selected ? ' sku-item--selected--ITGY_EO' : '')),
    querySelector: (sel) => (image && sel === 'img' ? { getAttribute: (k) => (k === 'alt' ? name : null) } : null),
    textContent: image ? '' : name, shadowRoot: null,
  });
  const ld = (rating, count, price) => ({ '@type': 'Product',
    aggregateRating: { ratingValue: String(rating), reviewCount: String(count) },
    offers: { price: String(price), priceCurrency: 'USD' } });
  const runStep5 = ({ path = '/item/1005007038434772.html', title = 'Metal Gyro', text, json = null, opts = [] }) => {
    const scripts = json ? [{ textContent: JSON.stringify(json) }] : [];
    const doc = { title, body: { innerText: text, textContent: text },
      querySelector: (sel) => (/ld\+json/.test(sel) ? scripts[0] || null : null),
      querySelectorAll: (sel) => (/ld\+json/.test(sel) ? scripts : opts) };
    return new Function('document', 'location', 'return (' + step5 + '\n)')(doc, { pathname: path });
  };
  const noise = opt('Color:D Ships From:China Mainland', { image: false, cls: 'list--itemSku--Zx9' });
  const g = JSON.parse(runStep5({ text: RV.gyro, json: ld(4.9, 5479, 1.58),
    opts: [opt('Black', { selected: true }), opt('Silver'), noise] }));
  eq('reviews is the OWN count (the bug: it was the pooled 5479)', g.reviews, 1090);
  eq('the pooled count is kept, under its own name', g.pooledReviews, 5479);
  ok('own and pooled differ on a pooled listing', g.reviews !== g.pooledReviews);
  eq('the "various sellers" note is reported', g.pooledNote, true);
  eq('sold from the header', g.soldRaw, '50,000+');
  eq('rating, price, currency and id from JSON-LD and the path', [g.rating, g.price, g.currency, g.id], [4.9, 1.58, 'USD', '1005007038434772']);
  eq('options from the selector, the selected one starred, no review line', g.options, ['Black*', 'Silver']);
  ok('the result fits the Chrome connector\'s 1,000-character limit', JSON.stringify(g).length < 1000, String(JSON.stringify(g).length));
  const d = JSON.parse(runStep5({ path: '/item/1005012967864709.html', text: RV.dumpling, json: ld(4.9, 4779, 2.48),
    opts: [opt('A', { selected: true }), opt('random 1pc')] }));
  eq('"100K+ sold" is read from the header', d.soldRaw, '100K+');
  eq('the 100K+ listing\'s own count', d.reviews, 488);
  const b = JSON.parse(runStep5({ path: '/item/1005008659361529.html', text: RV.boba, json: ld(4.8, 37, 11.35) }));
  eq('a listing without the note: own equals pooled', [b.reviews, b.pooledReviews, b.pooledNote], [37, 37, false]);
  const n = JSON.parse(runStep5({ text: RV.noBlock, json: ld(4.9, 5479, 1.58) }));
  eq('no review block: reviews is null, NOT the pooled number', n.reviews, null);
  const c = JSON.parse(runStep5({ text: 'More to love 4.8800+ sold cute toy ' + RV.gyro, json: ld(4.9, 5479, 1.58) }));
  eq('a product card\'s sold text earlier on the page does not win over the header', c.soldRaw, '50,000+');
  let threw = '';
  try { runStep5({ path: '/_____tmd_____/punish', text: 'Please slide to verify', json: null }); } catch (e) { threw = String(e); }
  ok('a wall throws, so a browser_batch stops right there', /WALL/.test(threw), threw);
  const e = JSON.parse(runStep5({ text: 'x'.repeat(900), json: null }));
  ok('no JSON-LD asks for a screenshot instead of a conclusion', /SCREENSHOT/.test(e.error || ''), e.error);
}

console.log('\nrank — a finalist with only the pooled count is set aside, not ranked on it');
{
  const r = rank([
    { id: 'own', title: 'gyro', rating: 4.9, reviews: 1090, pooledReviews: 5479, sold: 50000 },
    { id: 'pooledOnly', title: 'keychain', rating: 4.9, reviews: null, pooledReviews: 4026, sold: 50000 },
  ], ['--mode', 'final']);
  eq('only the listing with an own count is ranked', r.ranked.map((x) => x.id), ['own']);
  eq('the other is dropped as own-reviews-unknown, not "evidence<10"', r.droppedReasons['own-reviews-unknown'], 1);
  ok('and the ranker names it in a warning',
    r.warnings.some((w) => w.startsWith('own-reviews-unknown') && w.includes('pooledOnly')), JSON.stringify(r.warnings));
  const s = rank([{ id: 'x', title: 'y', rating: 4.9, sold: 5000 }], ['--mode', 'shortlist']);
  eq('shortlist mode is untouched by the own-count rule', s.ranked.map((x) => x.id), ['x']);
}

// ============================================================================
// 2026-10-18 — the wired-USB-mouse review (41 confirmed findings, merged).
// Every block below fails on the code of 2026-09-29. A block that throws is
// one failure (old code lacks some functions), never a crash of the suite.
// ============================================================================
const block = async (name, fn) => {
  try { await fn(); } catch (e) { fails.push(`${name} — threw ${String(e).slice(0, 160)}`); console.log(`  FAIL ${name} threw ${e}`); }
};
const { startReceiver: startRx } = await import('./receiver.mjs');
const fsx = await import('node:fs');
const osx = await import('node:os');
const tmp = (p) => fsx.mkdtempSync(join(osx.tmpdir(), p));
const freePort = async () => {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
};
const formDoc = (forms, extra = {}) => ({
  createElement: (tag) => ({ tag, appendChild(c) { (this.children = this.children || []).push(c); },
    submit() { this.submitted = true; forms.push(this); if (extra.onSubmit) extra.onSubmit(this); } }),
  body: { appendChild() {} }, ...extra.doc,
});
const harvestWith = async (win, fetchImpl, query = 'wire brush set', src = harvestSrc) => {
  new Function('window', 'fetch', src)(win, fetchImpl);
  win.__aeHarvest.start({ query });
  await win.__aeHarvest.step(1);
  return win.__aeHarvest;
};
const pageFetch = (pages) => async (url) => {
  if (url.startsWith('http://127.0.0.1:')) throw new TypeError('fetch failed');
  const p = Number(new URL(url).searchParams.get('page'));
  const ids = pages[p] || [];
  return reply(makePage({ items: ids.map((i) => makeItem(i)), page: p }));
};

console.log('\nsend() — a refused fetch must not navigate the harvest away (findings 0, 4, 30)');
await block('send refused fetch', async () => {
  const port = await freePort(); // nothing listens here
  const forms = [];
  const win = { document: formDoc(forms), localStorage: fakeStorage() };
  const H = await harvestWith(win, (url, init) => url.startsWith('http://127.0.0.1:')
    ? fetch(url, init) : Promise.resolve(reply(makePage({ items: [makeItem('s1')], finished: true }))));
  const msg = await H.send(port);
  ok('a refused fetch is reported NOT DELIVERED', /^NOT DELIVERED: FETCH-ERROR/.test(msg), msg);
  eq('and no form is posted (no navigation)', forms.length, 0);
  ok('the reply says the page did not navigate', /did NOT navigate/.test(msg), msg);
  ok('the reply names the liveness check', /curl -s http:\/\/127\.0\.0\.1:\d+\//.test(msg), msg);
  ok('the reply has no query string and fits the Chrome cap', !msg.includes('?') && msg.length < 1000, String(msg.length));
  eq('the harvest is still in the page', JSON.parse(H.payload()).items.length, 1);
  const forced = await H.send(port, { via: 'form' });
  ok('via:"form" still posts the form on purpose', /^UNCONFIRMED: form-posted/.test(forced) && forms.length === 1, forced);
});

console.log('\nsend() — every form POST is preceded by a localStorage backup (findings 0, 5, 30)');
await block('send backup before form', async () => {
  const forms = [];
  const ls = fakeStorage();
  let backupAtSubmit = null;
  const win = { document: formDoc(forms, { onSubmit: () => {
    const k = [...ls._m.keys()].find((x) => x.startsWith('__aeHarvest:wire-brush-set:'));
    backupAtSubmit = k ? ls.getItem(k) : null; } }), localStorage: ls };
  const H = await harvestWith(win, (url) => url.startsWith('http://127.0.0.1:')
    ? new Promise(() => {}) : Promise.resolve(reply(makePage({ items: [makeItem('b1'), makeItem('b2')], finished: true }))));
  const msg = await H.send(9999, { timeoutMs: 30 });
  ok('a held fetch is UNCONFIRMED, not a success', /^UNCONFIRMED: /.test(msg), msg);
  ok('the backup existed when the form was submitted', backupAtSubmit !== null && JSON.parse(backupAtSubmit).items.length === 2,
    String(backupAtSubmit).slice(0, 80));
  ok('the reply says the backup was saved and how to restore it', /backup saved \(2 items\)/.test(msg) && /restore\(\)/.test(msg), msg);
  // No storage at all: no form, because the navigation would end the only copy.
  const forms2 = [];
  const win2 = { document: formDoc(forms2, { doc: { visibilityState: 'hidden' } }) };
  const H2 = await harvestWith(win2, async () => reply(makePage({ items: [makeItem('n1')], finished: true })));
  const msg2 = await H2.send(9999);
  ok('without a backup no form is posted', /^NOT DELIVERED: no form posted/.test(msg2) && forms2.length === 0, msg2);
  const msg3 = await H2.send(9999, { force: true });
  ok('force:true posts anyway and says there is no backup', /^UNCONFIRMED: .*NO backup/.test(msg3) && forms2.length === 1, msg3);
  // A receiver that answers but rejects: NOT DELIVERED, and no form either.
  const forms3 = [];
  const win3 = { document: formDoc(forms3), localStorage: fakeStorage() };
  const H3 = await harvestWith(win3, (url) => url.startsWith('http://127.0.0.1:')
    ? Promise.resolve({ status: 400, text: async () => 'JSON has no items[]' })
    : Promise.resolve(reply(makePage({ items: [makeItem('r9')], finished: true }))));
  const msg4 = await H3.send(9999, { timeoutMs: 50 });
  ok('a 400 from the receiver is NOT DELIVERED', /^NOT DELIVERED: .*replied 400/.test(msg4) && forms3.length === 0, msg4);
});

console.log('\nrestore() — a fresh tab carries on from the next unread page (findings 1, 8, 33)');
await block('restore', async () => {
  const ls = fakeStorage();
  const fetched = [];
  const pages = { 1: ['a1', 'a2'], 2: ['b1', 'b2'], 3: ['c1'], 4: [] };
  const f = async (url) => { const p = Number(new URL(url).searchParams.get('page')); fetched.push(p); return pageFetch(pages)(url); };
  const w1 = { localStorage: ls };
  new Function('window', 'fetch', harvestSrc)(w1, f);
  w1.__aeHarvest.start({ query: 'wire brush set' });
  await w1.__aeHarvest.step(2);
  eq('status() reports the backup', w1.__aeHarvest.status().backup, { saved: true, items: 4 });
  // The stuck tab is closed. A new tab on the same origin shares localStorage.
  const w2 = { localStorage: ls };
  new Function('window', 'fetch', harvestSrc)(w2, f);
  const r = w2.__aeHarvest.restore();
  ok('restore() brings the harvest back', r.restored === true && r.unique === 4 && r.pagesRead === 2 && r.requests === 2, JSON.stringify(r));
  ok('restore() output carries no query string', !JSON.stringify(r).includes('?'), JSON.stringify(r));
  fetched.length = 0;
  const st = await w2.__aeHarvest.step(6);
  eq('step() goes on from page 3, never re-reading 1-2', fetched, [3, 4]);
  eq('the harvest is complete', [st.unique, st.stop, st.requests], [5, 'exhausted', 4]);
  const list = w2.__aeHarvest.backups();
  ok('backups() lists it without any URL', list.length === 1 && list[0].query === 'wire brush set' && !JSON.stringify(list).includes('?'),
    JSON.stringify(list));
  ok('dropBackup() removes it', /dropped/.test(w2.__aeHarvest.dropBackup('wire brush set')) && w2.__aeHarvest.backups().length === 0);
  const w3 = { localStorage: fakeStorage() };
  new Function('window', 'fetch', harvestSrc)(w3, f);
  ok('restore() with nothing saved says so', /no harvest backup/.test(w3.__aeHarvest.restore().err || ''));
});

console.log('\nreceiver.mjs — takes the second send, and its doc says how to check it (findings 1, 2, 4)');
await block('receiver defaults', async () => {
  const dir = tmp('ae-rx2-');
  const rx = await startRx({ dir, port: 0 }); // the defaults
  const post = (q) => fetch('http://127.0.0.1:' + rx.port + '/harvest', { method: 'POST', body: JSON.stringify({ query: q, items: [] }) });
  const a = await post('one'); const b = await post('two');
  eq('two payloads are both saved by default (it used to exit after one)', [a.status, b.status], [200, 200]);
  await new Promise((r) => setTimeout(r, 120));
  ok('and it is still listening', rx.server.listening === true);
  const g = await (await fetch('http://127.0.0.1:' + rx.port + '/')).text();
  ok('GET / says it is up, how many were saved, and the idle limit', /^ok 2 saved, idle 3600 s/.test(g), g);
  await rx.close();
  const { spawn } = await import('node:child_process');
  const port = await freePort();
  const cp = spawn('node', [join(HERE, 'receiver.mjs'), '--dir', dir, '--port', String(port)]);
  const line = await new Promise((res) => { let b2 = ''; cp.stdout.on('data', (d) => { b2 += d; if (b2.includes('\n')) res(b2); }); });
  ok('the CLI names its limits', /no payload limit, or 3600 s idle/.test(line), line);
  const c1 = await fetch('http://127.0.0.1:' + port + '/harvest', { method: 'POST', body: '{"query":"x","items":[]}' });
  const c2 = await fetch('http://127.0.0.1:' + port + '/harvest', { method: 'POST', body: '{"query":"y","items":[]}' });
  eq('the CLI with no --count takes two payloads', [c1.status, c2.status], [200, 200]);
  cp.kill();
  const bad = spawn('node', [join(HERE, 'receiver.mjs'), '--dir', dir, '--count', 'x']);
  const code = await new Promise((res) => bad.on('exit', res));
  eq('a bad --count is an error, not NaN', code, 2);
  ok('SKILL.md no longer says the receiver exits after one payload', !/exits after one payload/.test(skillSrc));
  ok('SKILL.md tells the operator to check the receiver before send()', /curl -s http:\/\/127\.0\.0\.1:8765\//.test(skillSrc));
});

console.log('\ndecode.mjs — several payloads are merged, never dropped (findings 3, 32)');
await block('decode merge', async () => {
  const { assemble, textsOf, mergePayloads } = await import('./decode.mjs');
  const P = (q, ids, pagesRead, verdict) => ({ query: q, source: 'harvest-paged', coverage: { verdict },
    pages: pagesRead.map((p) => ({ page: p })), items: ids.map((id) => ({ id, title: 't' + id, rating: 4.8 })) });
  const a = P('wire brush set', ['a', 'b'], [1, 2], 'truncated');
  const b = P('wire brush set', ['b', 'c'], [3, 4], 'exhausted-from-start-page');
  const r = assemble([JSON.stringify(a), JSON.stringify(b)]);
  eq('both payloads are kept, deduped by id', r.payload.items.map((i) => i.id), ['a', 'b', 'c']);
  ok('the merge is named', /^merged\(/.test(r.via), r.via);
  eq('pages 1-4 with no gap, one part ran dry: exhausted-all-results', r.payload.coverage.verdict, 'exhausted-all-results');
  eq('each input is listed', r.payload.parts.length, 2);
  const gap = mergePayloads([a, P('wire brush set', ['d'], [4, 5], 'exhausted-from-start-page')]);
  eq('a gap in the pages read is truncated, not complete', gap.coverage.verdict, 'truncated');
  const arr = assemble(textsOf(JSON.stringify([a, b])));
  eq('a JSON array of payloads is accepted (it was refused)', arr.payload.items.length, 3);
  const off = mergePayloads([a, { ...b, coverage: { verdict: 'off-query' } }]);
  eq('an off-query part makes the merge off-query', off.coverage.verdict, 'off-query');
  const dir = tmp('ae-dec-');
  fsx.writeFileSync(join(dir, 'a.json'), JSON.stringify(a)); fsx.writeFileSync(join(dir, 'b.json'), JSON.stringify(b));
  const out = execFileSync('node', [join(HERE, 'decode.mjs'), join(dir, 'a.json'), join(dir, 'b.json')], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  eq('the CLI keeps the second file\'s items', JSON.parse(out).items.map((i) => i.id), ['a', 'b', 'c']);
});

console.log('\nstart() — startPage, and a zero budget stays zero (findings 8, 9, 33)');
await block('start options', async () => {
  const fetched = [];
  const H = loadHarvest(async (url) => { const p = Number(new URL(url).searchParams.get('page')); fetched.push(p);
    return reply(makePage({ items: p < 14 ? [makeItem('sp' + p)] : [], page: p })); });
  const plan = H.start({ query: 'wire brush set', startPage: 12, maxRequests: 5 });
  eq('the plan names startPage', plan.startPage, 12);
  const st = await H.step(6);
  eq('fetching begins at startPage', fetched, [12, 13, 14]);
  eq('a startPage run that ran dry is not "all results"', JSON.parse(H.payload()).coverage.verdict, 'exhausted-from-start-page');
  eq('status names the start page', st.startPage, 12);
  let calls = 0;
  const H0 = loadHarvest(async () => { calls++; return reply(makePage({ items: [makeItem('z')] })); });
  eq('maxRequests: 0 stays 0 (it became 24)', H0.start({ query: 'x', maxRequests: 0 }).maxRequests, 0);
  const s0 = await H0.step(6);
  eq('and no request is made', [calls, s0.stop], [0, 'request-budget']);
  eq('maxPages: 0 stays 0 (it became 20)', H0.start({ query: 'x', maxPages: 0 }).maxPages, 0);
  let threw = '';
  try { H0.start({ query: 'x', maxRequests: 'lots' }); } catch (e) { threw = String(e); }
  ok('a non-number budget is refused', /maxRequests must be a whole number/.test(threw), threw);
});

console.log('\nstep() — a page with the anchor but another shape is a named stop (finding 10)');
await block('shape guard', async () => {
  let n = 0;
  const odd = '<html><script>/*--init-data-start--*/ window.x = { data: {"other":1} };</script></html>';
  const H = loadHarvest(async (url) => { n++; const p = Number(new URL(url).searchParams.get('page'));
    return reply(n === 1 ? odd : makePage({ items: p === 1 ? [makeItem('ok1')] : [], page: p })); });
  H.start({ query: 'wire brush set' });
  const st = await H.step(3);
  eq('it stops as parse-error instead of throwing', st.stop, 'parse-error');
  ok('lastErr names the missing shape', /no data\.root\.fields/.test(st.lastErr || ''), st.lastErr);
  eq('the page is not counted as read', st.pagesRead, 0);
  const r = H.resume();
  eq('resume() clears it and points at the same page', [r.resumed, r.nextPage], ['parse-error', 1]);
  const st2 = await H.step(3);
  eq('the retry reads page 1, not page 2', JSON.parse(H.payload()).items.map((i) => i.id), ['ok1']);
  eq('and the run then ends normally', st2.stop, 'exhausted');
});

console.log('\nresume() — a stop is no longer final (finding 12)');
await block('resume', async () => {
  let fail = true;
  const H = loadHarvest(async (url) => { const p = Number(new URL(url).searchParams.get('page'));
    if (p === 2 && fail) { fail = false; throw new Error('net blip'); }
    return reply(makePage({ items: p <= 3 ? [makeItem('rs' + p)] : [], page: p })); });
  H.start({ query: 'wire brush set' });
  const a = await H.step(6);
  eq('a transient error stops the run', [a.stop, a.pagesRead], ['fetch-error', 1]);
  H.resume();
  const b = await H.step(6);
  eq('after resume() the items are kept and the run completes', [b.stop, b.unique, b.requests], ['exhausted', 3, 5]);
  ok('an exhausted run is not resumed', /already ran dry/.test(H.resume().err || ''));
  const B = loadHarvest(async () => reply(makePage({ items: [makeItem('q')] })));
  B.start({ query: 'x', maxRequests: 1 });
  await B.step(3);
  B.resume({ maxRequests: 2 });
  eq('resume({ maxRequests }) lifts a budget stop on purpose', (await B.step(3)).requests, 2);
});

console.log('\nstart() / re-install while a loop runs (finding 13)');
await block('reentrancy', async () => {
  const win = {};
  let release;
  const gate = new Promise((r) => { release = r; });
  new Function('window', 'fetch', harvestSrc)(win, async (url) => { await gate; const p = Number(new URL(url).searchParams.get('page'));
    return reply(makePage({ items: p === 1 ? [makeItem('ri')] : [], page: p })); });
  win.__aeHarvest.start({ query: 'wire brush set' });
  const loop = win.__aeHarvest.step(3);
  let threw = '';
  try { win.__aeHarvest.start({ query: 'other' }); } catch (e) { threw = String(e); }
  ok('start() is refused while a loop runs', /still running/.test(threw), threw);
  const old = win.__aeHarvest;
  const msg = new Function('window', 'fetch', 'return (' + harvestSrc + '\n)')(win, async () => reply(makePage()));
  ok('re-installing while it runs leaves the running copy in place', win.__aeHarvest === old && /NOT replaced/.test(msg), msg);
  release();
  await loop;
  const msg2 = new Function('window', 'fetch', 'return (' + harvestSrc + '\n)')(win, async () => reply(makePage()));
  ok('re-installing when idle keeps the harvest', win.__aeHarvest !== old && win.__aeHarvest.status().unique === 1 && /kept the current harvest/.test(msg2), msg2);
});

console.log('\nstep() — a big quiet interstitial is a suspected wall, not a parse bug (finding 14)');
await block('big html no content', async () => {
  const big = '<html><head><script>' + 'var a=1;'.repeat(40000) + '</script></head><body><div>Loading</div></body></html>';
  const H = loadHarvest(async () => reply(big));
  H.start({ query: 'wire brush set' });
  const st = await H.step(2);
  eq('300 KB of HTML, no anchor, no punish string: suspect-wall', st.stop, 'suspect-wall');
  ok('named by the big-html rule', (st.wall && st.wall.markers || []).includes('big-html-no-content'), JSON.stringify(st.wall));
  const small = loadHarvest(async () => reply('<html>no payload here</html>'));
  small.start({ query: 'wire brush set' });
  eq('a short malformed page is still a parse-error', (await small.step(1)).stop, 'parse-error');
});

console.log('\nrelevance — an off-category stream is not "all results" (findings 6, 31)');
await block('relevance', async () => {
  const { queryRelevance } = await import('./lib.mjs');
  const wire = Array.from({ length: 30 }, (_, i) => makeItem('w' + i, { title: 'Aluminum Craft Wire 20 Gauge ' + i }));
  wire.push(makeItem('m1', { title: 'Wired USB Mouse Optical' }));
  const H = loadHarvest(async (url) => { const p = Number(new URL(url).searchParams.get('page'));
    return reply(makePage({ items: p === 1 ? wire : [], page: p })); });
  H.start({ query: 'wired usb mouse' });
  const st = await H.step(3);
  eq('status() says the stream is off-query', st.relevance.offQuery, true);
  ok('status() stays under the Chrome cap', JSON.stringify(st).length < 1000, String(JSON.stringify(st).length));
  const pl = JSON.parse(H.payload());
  eq('the verdict is off-query, not exhausted-all-results', pl.coverage.verdict, 'off-query');
  eq('the stream itself did run dry', pl.coverage.streamVerdict, 'exhausted-all-results');
  ok('the payload carries the warning', pl.warnings.some((w) => /^off-query-results: only 1 of 31/.test(w)), JSON.stringify(pl.warnings));
  ok('pages[] carries the per-page share', pl.pages[0].onQuery < 0.1, JSON.stringify(pl.pages[0]));
  const r = rank(pl, ['--mode', 'shortlist']);
  ok('rank.mjs repeats the warning', r.warnings.some((w) => /^off-query-results/.test(w)), JSON.stringify(r.warnings));
  const good = queryRelevance('wired usb mouse', ['Wired USB Mouse', 'USB Gaming Mouse', 'Optical Mouse for PC', 'Logitech M90 Mouse', 'Silent Mouse']);
  eq('a stream of mice raises nothing', [good.measured, good.warning], [true, null]);
  const he = queryRelevance('cheese grater', ['מגרדת גבינה', 'מגרדה סיבובית', 'מגרדת ירקות', 'מגרדת לימון', 'מגרדה']);
  eq('Hebrew titles are unmeasured, never off-query', [he.measured, he.reason], [false, 'titles-not-latin']);
  const brush = queryRelevance('wire brush set', ['Copper craft wire', 'Brass wire 1mm', 'Steel wire', 'Wire rope', 'Wire Brush 3pcs']);
  // The documented limit of the any-keyword rule: a stream sharing one keyword
  // passes, and keywordShare shows the noun's low share for a look by eye.
  ok('a stream sharing one keyword passes, with the noun\'s share visible ("craft wire" for "wire brush set")',
    brush.warning === null && brush.keywordShare.brush === 0.2, JSON.stringify(brush));
  const blk = harvestText.match(/\/\* @shared:queryRelevance:start \*\/([\s\S]*?)\/\* @shared:queryRelevance:end \*\//);
  ok('harvest.js exposes the @shared:queryRelevance block', !!blk);
  const inl = new Function(`${blk[1]}; return queryRelevance;`)();
  const cases = [['wired usb mouse', wire.map((w) => w.title.displayTitle)], ['wired usb mouse', ['Wired USB Mouse', 'x']],
    ['cheese grater', ['מגרדת גבינה']], ['', ['a']], ['mouse', []], ['wire brush set', ['Copper craft wire', 'Wire Brush']]];
  const drift = cases.filter(([q, t]) => JSON.stringify(inl(q, t)) !== JSON.stringify(queryRelevance(q, t)));
  eq('harvest.js queryRelevance agrees with lib.mjs', drift.length, 0);
});

console.log('\nSKILL.md / harvest.js — stop list, names, wording (findings 15, 35, 36-40)');
await block('doc names', async () => {
  const step3 = skillSrc.slice(skillSrc.indexOf('## Step 3'), skillSrc.indexOf('### Single-page fallback'));
  ok('the step-3 stop list names suspect-wall and what it means', /`suspect-wall`\*\* means .*screenshot/s.test(step3), 'missing');
  ok('harvest.js no longer names the removed blockedBy()', !/blockedBy/.test(harvestText));
  ok('SKILL.md names blockedBy() only as replaced history', (skillSrc.match(/blockedBy/g) || []).length === 1 && /replaces the old boolean `blockedBy\(\)`/.test(skillSrc));
  ok('SKILL.md presents no ownReviews field', !/now returns `ownReviews`/.test(skillSrc));
  ok('--spread is K of the --top N slots, not K+N', !/K\+N slots/.test(skillSrc) && /K of the `--top N` slots/.test(skillSrc));
  ok('the saved file name is the receiver\'s, and harvest.json is explained', /harvest-<query>-<stamp>\.json` in `--dir` and prints/.test(skillSrc));
  const ready = new Function('window', 'fetch', 'return (' + harvestSrc + '\n)')({}, null);
  ok('the install reply says await step(6), not step(8)', /await __aeHarvest\.step\(6\)/.test(ready) && !/step\(8\)/.test(ready), ready);
  ok('the harvest.js header says step(6) too', !/step\(8\)/.test(harvestText));
  const row = (skillSrc.match(/\| Result cut at \*\*1,000 characters\*\*[^\n]*/) || [''])[0];
  ok('the step-0 table names send() as the way out', /send\(/.test(row) && /fallback, visible tab only/.test(row), row);
  ok('the starter tab of createIfEmpty is to be closed too', /close the starter tab/.test(skillSrc));
});

console.log('\nrank — the brand rule: researching a house brand must not cost it score (finding 16)');
await block('brand rule', async () => {
  const m = skillSrc.match(/house brand \*\*([0-9.]+)\*\*/) || skillSrc.match(/house brand mid-low \(~([0-9.]+)\)/);
  ok('SKILL.md step 6 states a number for a house brand', !!m);
  const house = Number(m[1]);
  const r = rank([
    { id: 'house', title: 'house brand', rating: 4.9, reviews: 1000, sold: 5000, brandScore: house },
    { id: 'plain', title: 'no brand', rating: 4.9, reviews: 1000, sold: 5000 },
    { id: 'other', title: 'other', rating: 4.9, reviews: 1000, sold: 5000, brandScore: 0.85 },
  ], ['--mode', 'final', '--top', '5']);
  const g = (id) => r.ranked.find((x) => x.id === id).score;
  ok('a researched house brand does not rank below an identical brandless item', g('house') >= g('plain'), `house ${g('house')} plain ${g('plain')}`);
  ok('SKILL.md says below 0.5 needs evidence of a problem', /A score below 0\.5 needs evidence of a problem/.test(skillSrc));
});

console.log('\nrank — the absence warning blames the regex only when the regex emptied the pool (finding 17)');
await block('absence', async () => {
  const pool = Array.from({ length: 12 }, (_, i) => ({ id: 'w' + i, title: 'wired usb mouse', rating: 4.8, reviews: 50, sold: 500,
    constraints: { wired: 'fail' } }));
  const r = rank(pool, ['--mode', 'final', '--require', 'mouse', '--constraint', 'wired']);
  ok('no absence warning when the regex matched every title', !r.warnings.some((w) => /absence-is-not-evidence/.test(w)), JSON.stringify(r.warnings));
  ok('the constraint warning still fires', r.warnings.some((w) => /no candidate satisfies/.test(w)));
  const r2 = rank(pool.slice(0, 3), ['--mode', 'final', '--require', 'keyboard']);
  ok('a regex that drops a small pool whole still warns', r2.warnings.some((w) => /absence-is-not-evidence/.test(w)), JSON.stringify(r2.warnings));
});

console.log('\nrank — no own count and no pooled count is unknown, not thin (finding 18)');
await block('own unknown', async () => {
  const r = rank([
    { id: 'a', title: 'x', rating: 4.9, reviews: 800, pooledReviews: 800, sold: 5000 },
    { id: 'b', title: 'y', rating: 4.9, reviews: null, pooledReviews: null, sold: 50000 },
  ], ['--mode', 'final']);
  eq('dropped as own-reviews-unknown, not evidence<10', r.droppedReasons, { 'own-reviews-unknown': 1 });
  ok('and named in the warning', r.warnings.some((w) => /^own-reviews-unknown/.test(w) && w.includes('b')), JSON.stringify(r.warnings));
});

console.log('\nrank — a bad flag value is an error, never an empty ranking (finding 19)');
await block('flags', async () => {
  const pool = [{ id: 'a', title: 'x', rating: 4.9, sold: 5000 }, { id: 'b', title: 'y', rating: 4.8, sold: 3000 }];
  for (const args of [['--spread', 'x'], ['--spread'], ['--top'], ['--top', 'abc'], ['--spread', '--top', '5']]) {
    let code = 0, err = '';
    try { rank(pool, ['--mode', 'shortlist', ...args]); } catch (e) { code = e.status; err = String(e.stderr || ''); }
    ok(`${args.join(' ')} exits 2 with a message`, code === 2 && /rank\.mjs: --/.test(err), `code ${code} ${err}`);
  }
});

console.log('\nrank — a tie across the --top cut is named (finding 20)');
await block('ties', async () => {
  const pool = Array.from({ length: 14 }, (_, i) => ({ id: 't' + i, title: 'x', rating: 4.8, sold: 10000, soldBucketed: true }));
  const r = rank(pool, ['--mode', 'shortlist', '--top', '10']);
  const w = r.warnings.find((x) => /^tie-at-cutoff/.test(x)) || '';
  ok('the warning fires', !!w, JSON.stringify(r.warnings));
  ok('it counts and names the items left out', /14 items share score/.test(w) && /4 of them were left out/.test(w) && /t10, t11, t12, t13/.test(w), w);
  const r2 = rank(pool.slice(0, 10), ['--mode', 'shortlist', '--top', '10']);
  ok('no warning when nothing tied was left out', !r2.warnings.some((x) => /tie-at-cutoff/.test(x)));
});

console.log('\nrank — reviews-exceed-sold is not raised against a bucket floor (finding 21)');
await block('exceed floor', async () => {
  const r = rank([
    { id: 'floor', title: 'x', rating: 4.9, reviews: 1090, pooledReviews: 5479, ownRating: 4.9, soldRaw: '1,000+' },
    { id: 'exact', title: 'y', rating: 4.9, reviews: 1090, ownRating: 4.9, soldRaw: '455' },
    { id: 'sat', title: 'z', rating: 4.9, reviews: 300, ownRating: 4.9, soldRaw: '10,000+' },
  ], ['--mode', 'final', '--top', '5']);
  const f = (id) => r.ranked.find((x) => x.id === id).flags;
  ok('1,090 own reviews vs "1,000+" sold is not flagged', !f('floor').includes('reviews-exceed-sold'), JSON.stringify(f('floor')));
  ok('1,090 vs an exact 455 still is', f('exact').includes('reviews-exceed-sold'), JSON.stringify(f('exact')));
  ok('a reader record with "10,000+" now gets sold-saturated', f('sat').includes('sold-saturated'), JSON.stringify(f('sat')));
});

console.log('\nrank — --min-evidence 0 keeps a zero (finding 22)');
await block('min evidence 0', async () => {
  const r = rank([{ id: 'a', title: 'x', rating: 4.8, sold: 0 }, { id: 'b', title: 'y', rating: 4.8, sold: 50 }],
    ['--mode', 'shortlist', '--min-evidence', '0']);
  eq('both items are kept', r.ranked.map((x) => x.id).sort(), ['a', 'b']);
  ok('no false "evidence<0" reason', !Object.keys(r.droppedReasons).includes('evidence<0'), JSON.stringify(r.droppedReasons));
  ok('scores are numbers', r.ranked.every((x) => Number.isFinite(x.score)), JSON.stringify(r.ranked.map((x) => x.score)));
});

console.log('\nrank — final mode ranks on the listing\'s own rating (finding 23)');
await block('own rating', async () => {
  const r = rank([
    { id: 'A', title: 'pooled high', rating: 4.9, ownRating: 4.1, reviews: 1090, pooledReviews: 5479, sold: 5000 },
    { id: 'B', title: 'honest', rating: 4.6, ownRating: 4.6, reviews: 1090, pooledReviews: 1090, sold: 5000 },
  ], ['--mode', 'final', '--top', '2']);
  eq('the listing its own buyers rate higher ranks first', r.ranked.map((x) => x.id), ['B', 'A']);
  eq('ratingUsed is the own rating', r.ranked.find((x) => x.id === 'A').ratingUsed, 4.1);
  const r2 = rank([{ id: 'C', title: 'no own rating passed', rating: 4.9, reviews: 1090, pooledReviews: 5479, sold: 5000 }], ['--mode', 'final']);
  ok('a pooled listing without ownRating is flagged', r2.ranked[0].flags.includes('rating-may-be-pooled'), JSON.stringify(r2.ranked[0].flags));
  ok('SKILL.md step 7 tells the operator to pass ownRating', /Add `reviews` and `ownRating`/.test(skillSrc));
});

console.log('\nlisting.js — size lines, carton rule, description wall, HTTP error, text cut, options, specs (findings 24-29, 34)');
await block('listing', async () => {
  const listingSrc = RUN('listing.js');
  const el = (tag, p = {}) => ({ tagName: tag, children: p.children || [], textContent: p.text || '', className: p.cls || '',
    naturalWidth: 0, naturalHeight: 0, currentSrc: '', src: '', shadowRoot: null, parentElement: p.parent || null,
    getAttribute: (k) => (p.attrs || {})[k] || null, querySelector: () => null, querySelectorAll: () => p.qsa || [],
    closest: () => null, click() {}, id: p.id || '', nodeType: 1,
    childNodes: p.nodes || (p.text ? [{ nodeType: 3, nodeValue: p.text }] : []) });
  const run = ({ els = [], bodyText = 'x'.repeat(2500), win = {} }) => {
    const document = { body: { scrollHeight: 5000, innerText: bodyText }, documentElement: { outerHTML: '' },
      querySelectorAll: (sel) => (/ld\+json/.test(sel || '') ? [] : els) };
    const w = { scrollTo() {}, ...win, document };
    return new Function('window', 'document', 'location', `${listingSrc}; return window.__aeListing;`)(w, document, { href: 'https://he.aliexpress.com/item/1.html' });
  };
  // 24: a product size in a list that also says "Package includes"
  const ul = { textContent: 'Size: 22 x 12 x 28 cmWeight: 680 gPackage includes: 1 x grater' };
  const r24 = await run({ els: [el('LI', { text: 'Size: 22 x 12 x 28 cm', parent: ul }), el('LI', { text: 'Weight: 680 g', parent: ul }),
    el('LI', { text: 'Package includes: 1 x grater', parent: ul })] }).read({ description: false });
  eq('the product size stays a product size', r24.productSizeLines, ['Size: 22 x 12 x 28 cm']);
  eq('nothing is called the carton', r24.packageSizeLines, []);
  const pkgParent = { textContent: 'גודל המוצר: 8x3.7x2 סמ, גודל החבילה: 12×7×4 סמ' };
  const r24b = await run({ els: [el('SPAN', { text: '8x3.7x2 סמ', parent: pkgParent }), el('SPAN', { text: '12×7×4 סמ', parent: pkgParent })] })
    .read({ description: false });
  eq('a bare size takes the qualifier just before it', [r24b.productSizeLines, r24b.packageSizeLines], [['8x3.7x2 סמ'], ['12×7×4 סמ']]);
  // 25: <li><b>Size:</b> 22 x 12 x 28 cm</li>
  const b = el('B', { text: 'Size:' });
  const li = el('LI', { text: 'Size: 22 x 12 x 28 cm', children: [b] });
  const r25 = await run({ els: [li, b] }).read({ description: false });
  eq('a bold-label size is read as one line', r25.productSizeLines, ['Size: 22 x 12 x 28 cm']);
  const DESC = 'https://pdp.aliexpress-media.com/product/description/pc/v2/en_US/desc.htm?productId=1';
  const descWin = (body, status = 200) => ({
    performance: { getEntriesByType: () => [{ name: DESC }] },
    fetch: async () => ({ url: DESC, status, ok: status < 300, text: async () => '<html>' + body + '</html>' }),
    DOMParser: class { parseFromString() { const p = el('P', { text: body }); return { body: el('BODY', { qsa: [p], nodes: [p] }), querySelectorAll: () => [p] }; } },
  });
  // 26: the slider wall's text served at the description URL, no redirect
  const r26 = await run({ win: descWin('Sorry, we have detected unusual traffic from your network. Please slide to verify.') }).read();
  eq('a wall sentence in a short description fetch is a wall', [r26.description.source, r26.blocked], ['blocked', true]);
  ok('and it never reaches `text`', !/unusual traffic/.test(r26.text));
  const r26b = await run({ win: descWin('Please slide the drum into the holder until it clicks. Weight: about 680 g. Package includes 3 drums.') }).read();
  eq('seller copy "please slide" is still the description', r26b.description.source, 'fetched');
  // 29: an HTTP error page is not the description
  const r29 = await run({ win: descWin('403 Forbidden. Access denied: the request token has expired, please reload.', 403) }).read();
  eq('a 403 answer is fetch-failed, not fetched', r29.description.source, 'fetch-failed');
  ok('and its text is not product copy', !/Access denied/.test(r29.text));
  // 27: the description survives a long page
  const r27 = await run({ bodyText: 'p'.repeat(25000), win: descWin('Type: Wired. Weight: about 750 g, cable 1.8 m long.') }).read();
  ok('the description is kept when the page text passes maxText', /\[DESCRIPTION\] Type: Wired/.test(r27.text) && r27.text.length <= 20000, String(r27.text.length));
  ok('the cut is reported', r27.warnings.some((w) => /^text-cut/.test(w)) && r27.textCut.pageKept < 25000, JSON.stringify(r27.textCut));
  // 28: two option properties, both selected tiles kept
  const tile = (name, sel) => el('DIV', { cls: 'sku-item--text--Q' + (sel ? ' sku-item--selected--I' : ''), text: name });
  const r28 = await run({ els: [tile('Black', true), tile('White'), tile('Wireless'), tile('Wired USB', true)] }).read({ description: false });
  eq('every selected option is named', r28.selectedVariants, ['Black', 'Wired USB']);
  eq('selectedVariant is still the first', r28.selectedVariant, 'Black');
  // 34: specification rows
  const t = el('DIV', { cls: 'specification--title--S', text: 'Power Type' });
  const v = el('DIV', { cls: 'specification--desc--D', text: 'Wired' });
  const prop = el('DIV', { cls: 'specification--prop--J', children: [t, v], qsa: [t, v] });
  const r34 = await run({ els: [prop, t, v] }).read({ description: false });
  eq('spec rows come back as name: value', [r34.specs, r34.specsSource], [{ 'Power Type': 'Wired' }, 'dom']);
  const r34t = await run({ bodyText: 'Specifications\nBrand Name\nNONE\nType\nWired\nInterface Type\nUSB\nDescription\nmore' + 'x'.repeat(2500) })
    .read({ description: false });
  eq('the text fallback reads the lines after the heading', r34t.specs, { 'Brand Name': 'NONE', Type: 'Wired', 'Interface Type': 'USB' });
  const r34n = await run({}).read({ description: false });
  ok('no spec rows is a warning, never "not stated"', r34n.specsSource === 'none' && r34n.warnings.some((w) => /^specs-not-found/.test(w)));
});

console.log('\nSKILL.md step-5 reader — spec rows and every selected option (findings 28, 34)');
await block('step5 spec', async () => {
  const optEl = (name, sel) => ({ className: 'sku-item--text--Qa1' + (sel ? ' sku-item--selected--I' : ''), querySelector: () => null, textContent: name, shadowRoot: null });
  const specEl = (k, val) => ({ className: 'specification--prop--J', textContent: k + val, shadowRoot: null,
    querySelector: (sel) => (/title/.test(sel) ? { textContent: k } : /desc/.test(sel) ? { textContent: val } : null) });
  const els = [...['Black*', 'White', 'Pink', 'Blue', 'Green', 'Grey', 'Red', 'Purple', 'Gold', 'Navy', 'Teal']
    .map((n) => optEl(n.replace('*', ''), n.endsWith('*'))), optEl('Wireless'), optEl('Wired USB', true),
    specEl('Type', 'Wired'), specEl('Power Type', 'USB'), specEl('Battery Included', 'No'), specEl('Interface Type', 'USB'), specEl('Brand Name', 'NONE')];
  const ldj = [{ textContent: JSON.stringify({ '@type': 'Product', aggregateRating: { ratingValue: '4.9', reviewCount: '5479' }, offers: { price: '3.1', priceCurrency: 'USD' } }) }];
  const doc = { title: 'Mouse', body: { innerText: RV.gyro }, querySelectorAll: (sel) => (/ld\+json/.test(sel) ? ldj : els) };
  const out = new Function('document', 'location', 'return (' + step5 + '\n)')(doc, { pathname: '/item/1005007038434772.html' });
  const g = JSON.parse(out);
  eq('the wanted spec rows come back', [g.spec, g.specFrom], [{ Type: 'Wired', 'Power Type': 'USB', 'Battery Included': 'No', 'Interface Type': 'USB' }, 'dom']);
  ok('a selected option past the cap is still returned', g.options.includes('Wired USB*'), JSON.stringify(g.options));
  eq('optionCount is the total', g.optionCount, 13);
  ok('the result still fits the 1,000-character cap', out.length < 1000, String(out.length));
  const doc2 = { title: 'Mouse', body: { innerText: 'x\nSpecifications\nType\n2.4Ghz Wireless\nPower Type\nRechargeable\nDescription\n' + RV.gyro },
    querySelectorAll: (sel) => (/ld\+json/.test(sel) ? ldj : []) };
  const g2 = JSON.parse(new Function('document', 'location', 'return (' + step5 + '\n)')(doc2, { pathname: '/item/1.html' }));
  eq('the text fallback reads the rows after "Specifications"', [g2.spec, g2.specFrom], [{ Type: '2.4Ghz Wireless', 'Power Type': 'Rechargeable' }, 'text']);
  const g3 = JSON.parse(new Function('document', 'location', 'return (' + step5 + '\n)')({ ...doc2, body: { innerText: RV.gyro } }, { pathname: '/item/1.html' }));
  eq('no rows: specFrom none, spec empty', [g3.spec, g3.specFrom], [{}, 'none']);
  // Live 2026-10-18: a vertical mouse titled "Wired" had spec rows "Type: 2.4Ghz Wireless",
  // "Battery Included: Yes" and "Power Source: Rechargeable". WANT had no "Power Source",
  // so that row never came back.
  const els4 = [specEl('Type', '2.4Ghz Wireless'), specEl('Battery Included', 'Yes'), specEl('Power Source', 'Rechargeable')];
  const g4 = JSON.parse(new Function('document', 'location', 'return (' + step5 + '\n)')(
    { title: 'Mouse', body: { innerText: RV.gyro }, querySelectorAll: (sel) => (/ld\+json/.test(sel) ? ldj : els4) }, { pathname: '/item/1005006743691875.html' }));
  eq('step 5 returns the "Power Source" row from the DOM', g4.spec, { Type: '2.4Ghz Wireless', 'Battery Included': 'Yes', 'Power Source': 'Rechargeable' });
  const g5 = JSON.parse(new Function('document', 'location', 'return (' + step5 + '\n)')(
    { ...doc2, body: { innerText: 'x\nSpecifications\nPower Source\nRechargeable\nType\nWired\nDescription\n' + RV.gyro } }, { pathname: '/item/1.html' }));
  eq('step 5 returns the "Power Source" row from the text fallback', [g5.spec, g5.specFrom], [{ 'Power Source': 'Rechargeable', Type: 'Wired' }, 'text']);
  const all5 = [...els, specEl('Power Source', 'Rechargeable via USB-C cable')];
  const out5 = new Function('document', 'location', 'return (' + step5 + '\n)')(
    { title: 'Mouse', body: { innerText: RV.gyro }, querySelectorAll: (sel) => (/ld\+json/.test(sel) ? ldj : all5) }, { pathname: '/item/1005007038434772.html' });
  ok('five spec rows plus 13 options still fit the 1,000-character cap', out5.length < 1000 && JSON.parse(out5).spec['Power Source'] != null, String(out5.length));
});

console.log('\nextract.js — a version number in the title is not the rating (finding 7)');
await block('extract rating', async () => {
  const extractSrc = RUN('extract.js');
  const runX = (text) => JSON.parse(new Function('window', 'document', 'location', 'return (' + extractSrc + '\n)')({},
    { querySelectorAll: (sel) => (/ld\+json/.test(sel) ? [] : [{ href: 'https://he.aliexpress.com/item/1005000000000009.html',
      parentElement: { parentElement: null, textContent: text } }]),
      body: { innerText: 'x'.repeat(3000) }, documentElement: { outerHTML: '' }, title: 't' },
    { href: 'https://he.aliexpress.com/w/x.html', origin: 'https://he.aliexpress.com', pathname: '/w/x.html', search: '' })).items[0];
  const a = runX('Wireless Mouse Bluetooth 5.0 4.81,000+ sold US $4.92');
  eq('"Bluetooth 5.0 4.81,000+ sold" is 4.8 and 1,000', [a.rating, a.sold], [4.8, 1000]);
  const b = runX('USB Hub 3.0 4.9200+ sold US $2.10');
  eq('"USB Hub 3.0 4.9200+ sold" is 4.9 and 200', [b.rating, b.sold], [4.9, 200]);
  const c = runX('Glitter Squishy 4.9100K+ sold US $2.48');
  eq('the glued K form still works', [c.rating, c.sold], [4.9, 100000]);
});

console.log('\ninstall copies — compact, generated, no invisible characters, same behaviour (finding 11)');
await block('dist', async () => {
  const { build, SOURCES } = await import('./build.mjs');
  for (const name of SOURCES) {
    const dist = join(HERE, 'dist', name.replace(/\.js$/, '.min.js'));
    const cur = fsx.existsSync(dist) ? readFileSync(dist, 'utf8') : null;
    ok(`dist/${name.replace(/\.js$/, '.min.js')} equals a fresh build (run node scripts/build.mjs)`, cur === build(name));
    ok(`dist copy of ${name} is under 60% of the source`, cur && cur.length < 0.6 * readFileSync(join(HERE, name), 'utf8').length);
  }
  const CF = new RegExp('\\p{Cf}', 'u');
  const files = [...fsx.readdirSync(HERE).filter((f) => /\.(m?js|sh)$/.test(f)).map((f) => join(HERE, f)),
    ...fsx.readdirSync(join(HERE, 'dist')).map((f) => join(HERE, 'dist', f)), join(HERE, '..', 'SKILL.md'), join(HERE, '..', 'README.md')];
  const dirty = files.filter((f) => CF.test(readFileSync(f, 'utf8')));
  eq('no file holds a raw invisible format character', dirty, []);
  const minSrc = readFileSync(join(HERE, 'dist', 'harvest.min.js'), 'utf8');
  const scenario = async (src) => {
    const ls = fakeStorage(); const forms = [];
    const win = { document: formDoc(forms, { doc: { visibilityState: 'hidden' } }), localStorage: ls };
    const pages = { 1: ['m1', 'm2'], 2: ['m3'], 3: [] };
    new Function('window', 'fetch', src)(win, pageFetch(pages));
    const H = win.__aeHarvest;
    H.start({ query: 'wire brush set' });
    const st = await H.step(6);
    const sent = await H.send(9999);
    const w2 = { localStorage: ls };
    new Function('window', 'fetch', src)(w2, pageFetch(pages));
    const rs = w2.__aeHarvest.restore();
    const wall = loadHarvestFrom(src, async () => reply('<html>Please slide to verify</html>', 'https://he.aliexpress.com/_____tmd_____/punish?x5secdata=1'));
    wall.start({ query: 'x' });
    const ws = await wall.step(2);
    return JSON.stringify([st, JSON.parse(H.payload()).items.map((i) => i.sold), sent.slice(0, 40), forms.length, rs.unique, ws.stop]);
  };
  const loadHarvestFrom = (src, f) => { const w = {}; new Function('window', 'fetch', src)(w, f); return w.__aeHarvest; };
  const a = await scenario(harvestSrc), b2 = await scenario(minSrc);
  eq('dist/harvest.min.js behaves like harvest.js (paging, send, restore, wall)', b2.replace(/"visibility":"[a-z]+"/g, ''), a.replace(/"visibility":"[a-z]+"/g, ''));
  ok('SKILL.md step 3 installs the dist copy', /entire contents\*\* of `scripts\/dist\/harvest\.min\.js`/.test(skillSrc));
});

// ============================================================================
// 2026-10-18, second pass — a review of the fixes above ran the real code and
// confirmed 19 more defects (R0-R18). Each block fails on the first-pass code.
// ============================================================================
console.log('\nR0/R1 — send() in a hidden tab, and a held fetch, are not "not delivered"');
await block('R0 R1', async () => {
  ok('SKILL.md no longer says a dead port is harmless in every tab',
    !/start it again \(step 3\)\. A `send\(\)` to a dead port returns\s+`NOT DELIVERED`/.test(skillSrc));
  ok('SKILL.md says a hidden tab posts the form at once, so check first',
    /Do not skip this check in a hidden\s+tab/.test(skillSrc) && /posts the form at once/.test(skillSrc));
  const H = loadHarvest((url) => (url.startsWith('http://127.0.0.1:') ? new Promise(() => {})
    : Promise.resolve(reply(makePage({ items: [makeItem('h1')], finished: true })))));
  H.start({ query: 'wire brush set' });
  await H.step(1);
  const msg = await H.send(9999, { via: 'fetch', timeoutMs: 20 });
  ok('a held fetch with via:"fetch" is UNCONFIRMED: it may still arrive', /^UNCONFIRMED: FETCH-HELD/.test(msg), msg);
});

console.log('\nR2/R3 — one backup per run, newest first, only a few kept');
await block('R2 R3', async () => {
  const ls = fakeStorage();
  const mk2 = (pages, hang) => async (url) => {
    const p = Number(new URL(url).searchParams.get('page'));
    if (hang) return new Promise(() => {});
    return reply(makePage({ items: (pages[p] || []).map((i) => makeItem(i)), page: p }));
  };
  const w1 = { localStorage: ls };
  new Function('window', 'fetch', harvestSrc)(w1, mk2({ 1: ['old1', 'old2'], 2: [] }));
  w1.__aeHarvest.start({ query: 'usb mouse' });
  await w1.__aeHarvest.step(6);
  await new Promise((r) => setTimeout(r, 5)); // a later start time
  const w2 = { localStorage: ls };
  new Function('window', 'fetch', harvestSrc)(w2, mk2({}, true));
  w2.__aeHarvest.start({ query: 'usb mouse', fourStar: false, extra: '&shpf_co=CN' });
  void w2.__aeHarvest.step(6); // page 1 hangs; the tab is then lost
  const w3 = { localStorage: ls };
  new Function('window', 'fetch', harvestSrc)(w3, mk2({}));
  const r = w3.__aeHarvest.restore('usb mouse');
  eq('restore() returns the CURRENT run, not the older one of the same query', [r.unique, r.stop, r.pagesRead], [0, null, 0]);
  const pl = JSON.parse(w3.__aeHarvest.payload());
  eq('with its own filters', [pl.fourStar, pl.extraApplied], [false, true]);
  const r2 = w3.__aeHarvest.restore();
  eq('restore() with no query takes the newest run too', r2.unique, 0);
  // Pruning: at most 3 runs are kept.
  for (let k = 0; k < 5; k++) {
    await new Promise((res) => setTimeout(res, 3));
    const w = { localStorage: ls };
    new Function('window', 'fetch', harvestSrc)(w, mk2({ 1: ['p' + k], 2: [] }));
    w.__aeHarvest.start({ query: 'query ' + k });
    await w.__aeHarvest.step(3);
  }
  const keys = [...ls._m.keys()].filter((k) => k.startsWith('__aeHarvest:'));
  eq('only the 3 newest runs stay in localStorage', keys.length, 3);
  const list = w3.__aeHarvest.backups();
  eq('backups() lists them newest first', list.map((b) => b.query), ['query 4', 'query 3', 'query 2']);
  ok('backups() fits the Chrome cap', JSON.stringify(list).length < 1000, String(JSON.stringify(list).length));
  ok('dropBackup() of a query never saved says so', /^no backup for/.test(w3.__aeHarvest.dropBackup('never harvested')));
  // A full store: older runs are dropped and the save is tried again.
  const full = fakeStorage();
  const cap = 6000;
  const setItem = full.setItem;
  full.setItem = (k, v) => {
    const used = [...full._m.entries()].reduce((a, [kk, vv]) => a + (kk === k ? 0 : vv.length), 0);
    if (used + String(v).length > cap) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
    setItem(k, v);
  };
  full._m.set('__aeHarvest:big-old:1', 'x'.repeat(5500));
  const wq = { localStorage: full };
  new Function('window', 'fetch', harvestSrc)(wq, mk2({ 1: ['q1', 'q2'], 2: [] }));
  wq.__aeHarvest.start({ query: 'garlic press' });
  const sq = await wq.__aeHarvest.step(3);
  eq('a full store drops the older run and saves this one', [sq.backup && sq.backup.saved, full._m.has('__aeHarvest:big-old:1')], [true, false]);
});

console.log('\nR4 — receiver flags that would exit at once or bind a random port');
await block('R4', async () => {
  const { spawn } = await import('node:child_process');
  const dir = tmp('ae-rx4-');
  // Never the default port 8765: a live session may hold it.
  const fp = String(await freePort());
  for (const args of [['--port', fp, '--idle', '99999999'], ['--port', ''], ['--port', fp, '--idle', '0'], ['--port', '70000']]) {
    const cp = spawn('node', [join(HERE, 'receiver.mjs'), '--dir', dir, ...args]);
    let err = '';
    cp.stderr.on('data', (d) => { err += d; });
    const code = await new Promise((res) => { const t = setTimeout(() => { cp.kill(); res('running'); }, 1500); cp.on('exit', (c) => { clearTimeout(t); res(c); }); });
    ok(`receiver ${args.join(' ')} is refused with exit 2`, code === 2 && /must be a whole number/.test(err), `exit ${code} ${err}`);
  }
});

console.log('\nR5 — a page that throws half way is never half counted');
await block('R5', async () => {
  const odd = (id, field) => { const it = makeItem(id); if (field === 'img') it.image = { imgUrl: 12345 }; if (field === 'desc') it.trade = { tradeDesc: 777 };
    if (field === 'title') it.title = { displayTitle: 42 }; return it; };
  const H = loadHarvest(async (url) => { const p = Number(new URL(url).searchParams.get('page'));
    return reply(makePage({ items: p === 1 ? [odd('a', 'img'), odd('b', 'desc'), odd('c', 'title'), makeItem('d')] : [], page: p })); });
  H.start({ query: 'wire brush set' });
  const st = await H.step(3);
  eq('number-typed fields are read, not thrown on', [st.stop, st.unique], ['exhausted', 4]);
  let boom = true;
  const bad = makeItem('x2');
  Object.defineProperty(bad, 'prices', { get() { if (boom) throw new Error('odd item'); return {}; } });
  const pages2 = { 1: [makeItem('x1')], 2: [makeItem('y1'), bad], 3: [] };
  // Direct check on the real loop: a fetch reply whose JSON holds a getter cannot exist, so drive it with a
  // page object: patch JSON.parse for page 2 to return live objects.
  const realParse = JSON.parse;
  const W = {};
  new Function('window', 'fetch', 'JSON', harvestSrc)(W, async (url) => { const p = Number(new URL(url).searchParams.get('page'));
    return reply(`<html>/*init-data-start*/ x = { data: {"p":${p}} };</html>`); },
  { stringify: JSON.stringify, parse: (t) => { const o = realParse(t); if (o && o.p) return { data: { root: { fields: { pageInfo: {}, mods: { itemList: { content: pages2[o.p] } } } } } }; return o; } });
  W.__aeHarvest.start({ query: 'wire brush set' });
  const s1 = await W.__aeHarvest.step(6);
  eq('the throw stops the run on page 2, named', [s1.stop, /odd item/.test(s1.lastErr || '')], ['parse-error', true]);
  eq('page 2 is not counted, none of its items kept', [s1.pagesRead, s1.unique], [1, 1]);
  eq('resume() points back at page 2', W.__aeHarvest.resume().nextPage, 2);
  boom = false;
  const s2 = await W.__aeHarvest.step(6);
  const pl = JSON.parse(W.__aeHarvest.payload());
  eq('the retry reads page 2 whole and the pages have no gap', [s2.unique, pl.pages.map((x) => x.page)], [3, [1, 2, 3]]);
});

console.log('\nR6/R7 — a broken payload stays a parse-error; blank budgets are refused');
await block('R6 R7', async () => {
  const broken = '<html><script>' + 'var a=1;'.repeat(12000) + '</script><script>/*--init-data-start--*/ x = { data: {"a":1,} };</script></html>';
  const H = loadHarvest(async () => reply(broken));
  H.start({ query: 'wire brush set' });
  const st = await H.step(2);
  eq('anchor present, JSON broken: parse-error, not suspect-wall', st.stop, 'parse-error');
  ok('with the JSON error as the cause', /^json:/.test(st.lastErr || ''), st.lastErr);
  for (const v of ['', ' ', false, [], [3]]) {
    let threw = '';
    try { H.start({ query: 'x', maxRequests: v }); } catch (e) { threw = String(e); }
    ok(`maxRequests ${JSON.stringify(v)} is refused`, /must be a whole number/.test(threw), threw || 'accepted');
  }
  eq('a digit string is still fine', H.start({ query: 'x', maxRequests: '12' }).maxRequests, 12);
});

console.log('\nR8-R10 — relevance: a qualifier typed last, and Hebrew titles with English words');
await block('R8-R10', async () => {
  const { queryRelevance: qr } = await import('./lib.mjs');
  const mice = ['Gaming Mouse RGB 7200DPI', 'Silent Mouse for Laptop', 'Ergonomic Vertical Mouse', 'Optical Mouse Office', 'Logitech M90 Mouse'];
  for (const q of ['mouse wired', 'usb wired mouse', 'wired usb mouse']) {
    eq(`"${q}" on a stream of mice raises nothing`, qr(q, mice).warning, null);
  }
  for (const [q, ts] of [['headphones bluetooth', ['Wireless Headphones', 'Sport Headphones', 'Kids Headphones', 'Headphones Mic', 'Over Ear Headphones']],
    ['socks cotton', ['Men Socks', 'Ankle Socks', 'Thermal Socks', 'Sports Socks', 'Wool Socks']],
    ['knife kitchen', ['Chef Knife', 'Paring Knife', 'Bread Knife', 'Santoku Knife', 'Steak Knife']]]) {
    eq(`"${q}" on its own product raises nothing`, qr(q, ts).warning, null);
  }
  ok('the craft-wire stream is still off-query', qr('wired usb mouse', Array(10).fill('Aluminum Craft Wire 20 Gauge')).warning !== null);
  const he = ['כבל USB Type C 3A טעינה מהירה Samsung Xiaomi Huawei', 'כבל טעינה Type-C 2M Xiaomi Redmi', 'מתאם USB C OTG',
    'כבל USB C ל-USB C 100W', 'Baseus כבל USB Type C'];
  eq('Hebrew titles with English brands are unmeasured, not off-query', [qr('usb c cable 2m', he).measured, qr('usb c cable 2m', he).reason],
    [false, 'titles-not-latin']);
  const reword = (skillSrc.match(/re-word\s+the\s+query\s+\(([^)]*)\)/) || [])[1] || '';
  const sugg = [...reword.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  ok('SKILL.md suggests re-wordings', sugg.length >= 1, reword);
  ok('none of them raises the alarm on real mice', sugg.every((q) => qr(q, mice).warning === null), JSON.stringify(sugg));
});

console.log('\nR11/R12 — decode.mjs: two chunk sets, and a merge across queries');
await block('R11 R12', async () => {
  const { assemble, mergePayloads } = await import('./decode.mjs');
  const exportChunks = async (ids, startPage) => {
    const els = {};
    const body = { children: [], get firstChild() { return this.children[0] || null; }, insertBefore(el) { this.children = [el]; return el; } };
    const doc = { body, getElementById: (id) => els[id] || null,
      createElement: () => { const el = { textContent: '', setAttribute() {} };
        Object.defineProperty(el, 'id', { set(v) { els[v] = el; }, get() { return '__aePayload'; } }); return el; } };
    const win = { document: doc };
    new Function('window', 'fetch', harvestSrc)(win, async (url) => { const p = Number(new URL(url).searchParams.get('page'));
      return reply(makePage({ items: p === startPage ? ids.map((i) => makeItem(i, { title: 'brush ' + 'z'.repeat(60) })) : [], page: p })); });
    win.__aeHarvest.start({ query: 'wire brush set', startPage });
    await win.__aeHarvest.step(3);
    const n = win.__aeHarvest.chunks(400).count;
    const dumps = [];
    const dumpOf = (i) => { win.__aeHarvest.expose(i, 400); return 'Title\n' + els.__aePayload.textContent + '\nfooter'; };
    for (let i = 0; i < n; i++) dumps.push(dumpOf(i));
    return { dumps, n, H: win.__aeHarvest, dumpOf };
  };
  const one = await exportChunks(['a1', 'a2', 'a3'], 1);
  const two = await exportChunks(['b1', 'b2', 'b3'], 1);
  ok('the fixture has the same chunk count twice', one.n === two.n && one.n >= 2, `${one.n} ${two.n}`);
  const r = assemble([...one.dumps, ...two.dumps]);
  eq('two chunk sets with the same count are both kept', r.payload.items.map((i) => i.id).sort(), ['a1', 'a2', 'a3', 'b1', 'b2', 'b3']);
  // A payload that changed between two exposes cannot be stitched together.
  const mid = await exportChunks(['c1', 'c2', 'c3'], 1);
  mid.H.st.items.push({ id: 'late', title: 'brush late' }); // the harvest changed between two exposes
  let err = '';
  try { assemble([mid.dumps[0], mid.dumpOf(1)]); } catch (e) { err = String(e); }
  ok('chunks of two different payload states are never stitched', /missing chunk/.test(err), err || 'decoded');
  const P = (q, ids, pages, verdict) => ({ query: q, coverage: { verdict }, pages: pages.map((page) => ({ page })), items: ids.map((id) => ({ id, title: q, rating: 4.8, sold: 500 })) });
  const m = mergePayloads([P('cheese grater', ['g1'], [1, 2, 3, 4, 5], 'exhausted-all-results'), P('vegetable slicer', ['v1'], [1, 2], 'truncated')]);
  eq('a truncated query keeps the merge truncated', m.coverage.verdict, 'truncated');
  eq('each query has its own verdict', m.coverage.byQuery.map((x) => x.verdict), ['exhausted-all-results', 'truncated']);
  const rr = rank(m, ['--mode', 'shortlist', '--min-evidence', '1']);
  ok('rank.mjs repeats the merged-queries warning', rr.warnings.some((w) => /^merged-queries/.test(w)), JSON.stringify(rr.warnings));
});

console.log('\nR13 — tie-at-cutoff with --spread names only items really left out');
await block('R13', async () => {
  const pool = Array.from({ length: 14 }, (_, i) => ({ id: 't' + i, title: 'x', rating: 4.8, sold: 10000, soldBucketed: true }));
  const r = rank(pool, ['--mode', 'shortlist', '--top', '10', '--spread', '4']);
  const w = r.warnings.find((x) => /^tie-at-cutoff/.test(x)) || '';
  const inIds = new Set(r.ranked.map((x) => x.id));
  const named = (w.match(/\(([^)]*)\)/) || ['', ''])[1].split(', ').filter((x) => /^t\d+$/.test(x));
  ok('no id named as left out is in ranked', named.length > 0 && named.every((id) => !inIds.has(id)), w);
  ok('the count is the real one (4)', /4 of them were left out/.test(w), w);
  const r2 = rank(pool.slice(0, 10), ['--mode', 'shortlist', '--top', '10', '--spread', '4']);
  ok('no warning when every tied item is in', !r2.warnings.some((x) => /tie-at-cutoff/.test(x)), JSON.stringify(r2.warnings));
});

console.log('\nR14-R17 — listing.js: <br> lines, a digit in the carton label, a Hebrew wall, spec rows by name');
const listingScenarios = async (src) => {
  const el = (tag, p = {}) => ({ tagName: tag, children: p.children || [], textContent: p.text || '', className: p.cls || '',
    naturalWidth: 0, naturalHeight: 0, currentSrc: '', src: '', shadowRoot: null, parentElement: p.parent || null,
    getAttribute: (k) => (p.attrs || {})[k] || null, querySelector: () => null, querySelectorAll: () => p.qsa || [],
    closest: () => null, click() {}, id: p.id || '', nodeType: 1,
    childNodes: p.nodes || (p.text ? [{ nodeType: 3, nodeValue: p.text }] : []) });
  const run = ({ els = [], bodyText = 'x'.repeat(2500), win = {} }) => {
    const document = { body: { scrollHeight: 5000, innerText: bodyText }, documentElement: { outerHTML: '' },
      querySelectorAll: (sel) => (/ld\+json/.test(sel || '') ? [] : els) };
    const w = { scrollTo() {}, ...win, document };
    return new Function('window', 'document', 'location', `${src}; return window.__aeListing;`)(w, document, { href: 'https://he.aliexpress.com/item/1.html' });
  };
  const DESC = 'https://pdp.aliexpress-media.com/product/description/pc/v2/he_IL/desc.htm?productId=1';
  const descWin = (body, status = 200) => ({ performance: { getEntriesByType: () => [{ name: DESC }] },
    fetch: async () => ({ url: DESC, status, text: async () => '<html>' + body + '</html>' }),
    DOMParser: class { parseFromString() { const p = el('P', { text: body }); return { body: el('BODY', { qsa: [p], nodes: [p] }), querySelectorAll: () => [p] }; } } });
  const out = {};
  const b = el('B', { text: 'Size:' }); const br = el('BR');
  out.br = (await run({ els: [el('P', { text: 'Size: 22 x 12 x 28 cm', children: [b, br] }), b, br] }).read({ description: false })).productSizeLines;
  const par = { textContent: 'Package Size (1pc): 12x7x4cm Weight: 59 g' };
  const r15 = await run({ els: [el('SPAN', { text: '12x7x4cm', parent: par })] }).read({ description: false });
  out.pkg = [r15.productSizeLines, r15.packageSizeLines];
  const r16 = await run({ win: descWin('אנו מזהים תעבורה חריגה מהרשת שלך. נא להחליק את המחוון כדי לאמת שאתה אנושי.') }).read();
  out.heWall = [r16.description.source, r16.blocked];
  const r16b = await run({ win: descWin('Sorry, we have detected unusual traffic from your network. ' + 'Please slide to verify. '.repeat(50)) }).read();
  out.enLong = [r16b.description.source, r16b.blocked];
  const r16c = await run({ win: descWin('נא להחליק את המכסה עד הסוף. משקל: 680 גרם. באריזה: 3 תופים ומגרדה אחת.') }).read();
  out.heCopy = r16c.description.source;
  const r17 = await run({ bodyText: 'Customer Reviews\nSpecifications\nDescription\nx\nSpecifications\nBrand Name\nNONE\nModel Number\n\nType\nWired\nPower Type\nUSB\nDescription\n' + 'y'.repeat(2500) })
    .read({ description: false });
  out.specs = [r17.specs, r17.specsSource];
  return out;
};
await block('R14-R17', async () => {
  const listingSrc = RUN('listing.js');
  const o = await listingScenarios(listingSrc);
  eq('<p><b>Size:</b> 22 x 12 x 28 cm<br></p> is a product size line', o.br, ['Size: 22 x 12 x 28 cm']);
  eq('"Package Size (1pc): 12x7x4cm" is the carton', o.pkg, [[], ['12x7x4cm']]);
  eq('a Hebrew slider wall at the description URL is a wall', o.heWall, ['blocked', true]);
  eq('an English wall past 1,000 chars is a wall too', o.enLong, ['blocked', true]);
  eq('Hebrew seller copy "נא להחליק את המכסה" is still the description', o.heCopy, 'fetched');
  eq('spec rows by name: an empty value shifts nothing, a tab label is skipped', o.specs,
    [{ 'Brand Name': 'NONE', 'Model Number': '', Type: 'Wired', 'Power Type': 'USB' }, 'text']);
});

console.log('\nR18 — build.mjs: a regex after if (...), line continuations, and the dist copies behave');
await block('R18', async () => {
  const { strip, buildSource } = await import('./build.mjs');
  const code = 'var s = "a//b"; var hit = 0; if (s) /\\/\\//.test(s) && hit++; var t = (4) / 2 / 1;';
  const stripped = strip(code);
  eq('a regex after the ")" of if(...) survives', [new Function(code + ' return [hit, t];')(), new Function(stripped + ' return [hit, t];')()],
    [[1, 2], [1, 2]]);
  let threw = '';
  try { strip('var a = "ab\\\n  cd";'); } catch (e) { threw = String(e); }
  ok('a string line continuation is refused, not silently changed', /continues over a line/.test(threw), threw);
  let bt = '';
  try { buildSource('x.js', '(() => { var a = ; })()'); } catch (e) { bt = String(e); }
  ok('a copy that would not parse is refused by the build', /does not parse/.test(bt), bt || 'built');
  const listingDist = readFileSync(join(HERE, 'dist', 'listing.min.js'), 'utf8');
  const a = await listingScenarios(readFileSync(join(HERE, 'listing.js'), 'utf8'));
  const b = await listingScenarios(listingDist);
  eq('dist/listing.min.js behaves like listing.js', JSON.stringify(b), JSON.stringify(a));
  const exSrc = readFileSync(join(HERE, 'extract.js'), 'utf8');
  const exDist = readFileSync(join(HERE, 'dist', 'extract.min.js'), 'utf8');
  const runX = (src, text, win = {}) => new Function('window', 'document', 'location', 'return (' + src + '\n)')(win,
    { querySelectorAll: (sel) => (/ld\+json/.test(sel) ? [] : [{ href: 'https://he.aliexpress.com/item/1005000000000009.html',
      parentElement: { parentElement: null, textContent: text } }]), body: { innerText: 'x'.repeat(3000) }, documentElement: { outerHTML: '' }, title: 't' },
    { href: 'https://he.aliexpress.com/w/x.html?page=2', origin: 'https://he.aliexpress.com', pathname: '/w/x.html', search: '?page=2' });
  const cards = ['Wireless Mouse Bluetooth 5.0 4.81,000+ sold US $4.92 US $9.90 -50% Free shipping', 'מגב 4.9 2,000+ נמכרו ₪18.30', 'Squishy 4.9100K+ sold US $2.48'];
  const initWin = { _dida_config_: { _init_data_: { data: { data: { root: { fields: { mods: { itemList: { content: [
    { productId: 'e1', title: { displayTitle: 'Clip Mop' }, prices: { salePrice: { minPrice: 9.5, currencyCode: 'USD' } }, evaluation: { starRating: 4.8 }, trade: { tradeDesc: '3,000+ sold' } }] } } } } } } } } };
  eq('dist/extract.min.js behaves like extract.js', [...cards.map((t) => runX(exDist, t)), runX(exDist, '', initWin)],
    [...cards.map((t) => runX(exSrc, t)), runX(exSrc, '', initWin)]);
  ok('SKILL.md says the whole suite runs on the dist copies', /runs the WHOLE suite\s+a second time on the three dist copies/.test(skillSrc));
});

// ============================================================================
// 2026-10-18, third pass — a review of the second pass confirmed 8 more
// (S1-S8). Each block fails on the second-pass code.
// ============================================================================
console.log('\nS1/S2 — relevance never flags a correct stream, whatever word comes last');
await block('S1 S2', async () => {
  const { queryRelevance: qr } = await import('./lib.mjs');
  const cases = [
    ['rc car', ['RC Car 1:16 4WD Off Road', 'Remote Control Car for Kids', 'Drift Car RC 2.4G', 'Off Road Car Toy', 'Monster Truck RC Car']],
    ['coil spring', ['Compression Spring 10pcs', 'Steel Spring Assortment Kit', 'Extension Springs', 'Torsion Spring', 'Spring Set 200pcs']],
    ['faux leather', ['PU Leather Sheet A4', 'Faux Leather Fabric Roll', 'Leather Vinyl Roll', 'Synthetic Leather Craft', 'Litchi Leather Sheets']],
    ['magnifying glass', ['Magnifier 10X Handheld', 'Handheld Magnifying Glass LED', 'Reading Magnifier', 'Loupe 30X', 'Glass Lens Magnifier']],
    ['mouse optical', ['Gaming Mouse RGB', 'Silent Mouse', 'Ergonomic Vertical Mouse', 'Wired Mouse USB', 'Office Mouse']],
    ['mouse for computer', ['Gaming Mouse RGB', 'Silent Mouse', 'Ergonomic Vertical Mouse', 'Wired Mouse USB', 'Office Mouse']],
    ['mouse wired quiet', ['Gaming Mouse RGB', 'Silent Mouse', 'Ergonomic Vertical Mouse', 'Wired Mouse USB', 'Office Mouse']],
  ];
  for (const [q, ts] of cases) eq(`"${q}" on its own product raises nothing`, qr(q, ts).warning, null);
  // The real 2026-10-17 streams, from the fixture inside the skill (it used
  // to read another session's scratchpad and skip when that was gone).
  const fx = JSON.parse(SRC('fixtures/real-titles-2026-10-17.json'));
  for (const q of ['wired usb mouse', 'mouse wired', 'mouse corded', 'mouse for computer']) {
    ok(`real craft-wire stream is off-query for "${q}"`, qr(q, fx.craftWire.titles).warning !== null);
    eq(`real mouse stream (${fx.mice.titles.length} titles) is never off-query for "${q}"`, qr(q, fx.mice.titles).warning, null);
  }
  ok('wire is still not wired', qr('wired usb mouse', Array(10).fill('Aluminum Craft Wire 20 Gauge')).warning !== null);
});

console.log('\nS3 — rank.mjs keeps a merged part\'s off-query warning');
await block('S3', async () => {
  const { mergePayloads } = await import('./decode.mjs');
  const off = { query: 'wired usb mouse', coverage: { verdict: 'off-query' }, pages: [{ page: 1 }],
    warnings: ['off-query-results: only 0 of 20 titles hold any of the keywords [wired, usb, mouse]. ...'],
    items: Array.from({ length: 20 }, (_, i) => ({ id: 'w' + i, title: 'Aluminum Craft Wire ' + i, rating: 4.8, sold: 5000 })) };
  const good = { query: 'usb mouse', coverage: { verdict: 'exhausted-all-results' }, pages: [{ page: 1 }, { page: 2 }], warnings: [],
    items: Array.from({ length: 40 }, (_, i) => ({ id: 'm' + i, title: 'USB Mouse ' + i, rating: 4.8, sold: 5000 })) };
  const m = mergePayloads([off, good]);
  const r = rank(m, ['--mode', 'shortlist']);
  ok('the part\'s off-query warning reaches the ranking', r.warnings.some((w) => /^off-query-results: only 0 of 20/.test(w)), JSON.stringify(r.warnings));
});

console.log('\nS4/S5 — the nearest label decides, and a <br> block is split into lines');
const listingScenarios2 = async (src) => {
  const el = (tag, p = {}) => ({ tagName: tag, children: p.children || [], textContent: p.text || '', className: p.cls || '',
    naturalWidth: 0, naturalHeight: 0, currentSrc: '', src: '', shadowRoot: null, parentElement: p.parent || null,
    getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [], closest: () => null, click() {}, id: '',
    nodeType: 1, childNodes: p.nodes || (p.text ? [{ nodeType: 3, nodeValue: p.text }] : []) });
  const t = (v) => ({ nodeType: 3, nodeValue: v });
  const run = (els, bodyText = 'x'.repeat(2500)) => {
    const document = { body: { scrollHeight: 5000, innerText: bodyText }, documentElement: { outerHTML: '' },
      querySelectorAll: (sel) => (/ld\+json/.test(sel || '') ? [] : els) };
    return new Function('window', 'document', 'location', `${src}; return window.__aeListing;`)({ scrollTo() {}, document }, document,
      { href: 'https://he.aliexpress.com/item/1.html' }).read({ description: false });
  };
  const sizes = (r) => [r.productSizeLines, r.packageSizeLines];
  const out = {};
  const ul1 = { textContent: 'Package: 1 x MouseProduct size:12 x 6 x 4 cm' };
  out.nearest = sizes(await run([el('LI', { text: 'Package: 1 x Mouse', parent: ul1 }), el('LI', { text: 'Product size:', parent: ul1 }),
    el('LI', { text: '12 x 6 x 4 cm', parent: ul1 })]));
  const ul2 = { textContent: 'Package includes: 1 x graterSize22 x 12 x 28 cm' };
  out.afterValue = sizes(await run([el('LI', { text: 'Package includes: 1 x grater', parent: ul2 }), el('LI', { text: 'Size', parent: ul2 }),
    el('LI', { text: '22 x 12 x 28 cm', parent: ul2 })]));
  const old = { textContent: 'גודל החבילה: 12×7×4 סמ, משקל: 0.059 קג' };
  out.carton = sizes(await run([el('SPAN', { text: '12×7×4 סמ', parent: old })]));
  const br1 = el('BR'), br2 = el('BR'), br3 = el('BR'), br4 = el('BR'), br5 = el('BR');
  out.block = sizes(await run([el('P', { text: 'Specification:Material: ABSSize: 22*12*28cmWeight: 500gPackage Included:1 x Grater',
    children: [br1, br2, br3, br4, br5],
    nodes: [t('Specification:'), br1, t('Material: ABS'), br2, t('Size: 22*12*28cm'), br3, t('Weight: 500g'), br4, t('Package Included:'), br5, t('1 x Grater')] })]));
  const b1 = el('BR');
  out.two = sizes(await run([el('P', { text: 'Size: 22 x 12 x 28 cmPackage size: 30 x 20 x 10 cm', children: [b1],
    nodes: [t('Size: 22 x 12 x 28 cm'), b1, t('Package size: 30 x 20 x 10 cm')] })]));
  const s1 = el('SPAN', { text: 'Size: 22x12x28cm' }), s2 = el('SPAN', { text: 'Package size: 30x20x10cm' }), b2 = el('BR');
  out.spans = sizes(await run([el('P', { text: 'Size: 22x12x28cmPackage size: 30x20x10cm', children: [s1, b2, s2], nodes: [s1, b2, s2] }), s1, s2]));
  return out;
};
await block('S4 S5', async () => {
  const o = await listingScenarios2(readFileSync(join(HERE, 'listing.js'), 'utf8'));
  eq('"Package: 1 x Mouse" then "Product size:" then the size: product', o.nearest, [['12 x 6 x 4 cm'], []]);
  eq('"Package includes: 1 x grater" then "Size" then the size: product', o.afterValue, [['22 x 12 x 28 cm'], []]);
  eq('the original carton case still is the carton', o.carton, [[], ['12×7×4 סמ']]);
  eq('a <br> spec block: the size line alone, as product', o.block, [['Size: 22*12*28cm'], []]);
  eq('<p>Size …<br>Package size …</p>: one product, one carton', o.two, [['Size: 22 x 12 x 28 cm'], ['Package size: 30 x 20 x 10 cm']]);
  eq('spans split by <br>: no spurious carton entry', o.spans, [['Size: 22x12x28cm'], ['Package size: 30x20x10cm']]);
  const d = await listingScenarios2(readFileSync(join(HERE, 'dist', 'listing.min.js'), 'utf8'));
  eq('dist/listing.min.js gives the same', JSON.stringify(d), JSON.stringify(o));
});

console.log('\nS6 — spec text rows: a value that is a name, a Hebrew table, a Hebrew end heading');
await block('S6', async () => {
  const src = RUN('listing.js');
  const run = (bodyText) => {
    const document = { body: { scrollHeight: 5000, innerText: bodyText + '\n' + 'x'.repeat(2500) }, documentElement: { outerHTML: '' },
      querySelectorAll: () => [] };
    return new Function('window', 'document', 'location', `${src}; return window.__aeListing;`)({ scrollTo() {}, document }, document,
      { href: 'https://he.aliexpress.com/item/1.html' }).read({ description: false });
  };
  const a = await run('Specifications\nFeature\nWaterproof\nType\nWired\nDescription');
  eq('a value that is itself a spec name stays a value', a.specs, { Feature: 'Waterproof', Type: 'Wired' });
  ok('a text-path read carries the confirm warning', a.warnings.some((w) => /^specs-from-text/.test(w)), JSON.stringify(a.warnings));
  const b = await run('מפרטים\nשם המותג\nNONE\nסוג\nחוטי\nתיאור\nטקסט');
  eq('a Hebrew table is text-raw with its lines, not silently empty', [b.specsSource, /שם המותג \| NONE \| סוג \| חוטי/.test(b.specsText || '')],
    ['text-raw', true]);
  ok('the Hebrew end heading stops the raw lines', !/טקסט/.test(b.specsText || ''), b.specsText);
  ok('and the read says the rows are unknown', b.warnings.some((w) => /^specs-not-found: .*specsText/.test(w)), JSON.stringify(b.warnings));
  const c = await run('Specifications\nModel Number\nGender\nMen\nType\nWired\nDescription');
  eq('a missing value next to a known name does not shift the rows', c.specs, { 'Model Number': '', Gender: 'Men', Type: 'Wired' });
});

console.log('\nS7 — decode.mjs joins pages only within one search stream (query AND filters)');
await block('S7', async () => {
  const { mergePayloads } = await import('./decode.mjs');
  const mkH = async (opts, pages) => {
    const H = loadHarvest(async (url) => { const p = Number(new URL(url).searchParams.get('page'));
      return reply(makePage({ items: (pages[p] || []).map((i) => makeItem(i)), page: p })); });
    H.start({ query: 'wire brush set', ...opts });
    await H.step(6);
    return JSON.parse(H.payload());
  };
  const fa = await mkH({ extra: '&shpf_co=CN', maxRequests: 3 }, { 1: ['a1'], 2: ['a2'], 3: ['a3'], 4: ['a4'] });
  const fb = await mkH({ startPage: 4 }, { 4: ['b4'], 5: ['b5'], 6: [] });
  ok('payloads name their filters without echoing them', fa.filterKey && fa.filterKey !== fb.filterKey && !JSON.stringify(fa).includes('shpf'));
  const m = mergePayloads([fa, fb]);
  eq('a recovery run with other filters does not complete the first', m.coverage.verdict, 'truncated');
  ok('and the merge says the filters differ', m.warnings.some((w) => /^merged-filters/.test(w)), JSON.stringify(m.warnings));
  const fc = await mkH({ extra: '&shpf_co=CN', startPage: 4 }, { 4: ['c4'], 5: [] });
  eq('the same filters do join', mergePayloads([fa, fc]).coverage.verdict, 'exhausted-all-results');
  ok('SKILL.md tells the recovery start() to keep fourStar and extra', /plus the SAME `fourStar` and `extra` as the first run/.test(skillSrc));
});

console.log('\nS8 — doc text matches the code');
await block('S8', async () => {
  ok('SKILL.md states the any-keyword rule', /holding at least one query keyword as a whole word/.test(skillSrc));
  ok('SKILL.md no longer states "at least two of its keywords"', !/at least two of its keywords/.test(skillSrc));
});

// ============================================================================
// 2026-10-18, fourth pass — six reviewers at higher effort (harvest state,
// export, relevance + rank, decode, listing in real Chromium, docs + build +
// tests). Each block below fails on the code they reviewed (pass3).
// ============================================================================
const realTitles = JSON.parse(SRC('fixtures/real-titles-2026-10-17.json'));

console.log('\nW1 — harvest.js: rows without ids, HTTP errors, "?" in lastErr, carry-over start time');
await block('W1', async () => {
  const noId = (i) => { const it = makeItem('x' + i); delete it.productId; return it; };
  const H = loadHarvest(async (url) => { const p = Number(new URL(url).searchParams.get('page'));
    return reply(makePage({ items: p === 1 ? [makeItem('a1'), makeItem('a2')] : p === 2 ? [noId(1), noId(2), noId(3)] : [], page: p })); });
  H.start({ query: 'wire brush set' });
  const st = await H.step(6);
  eq('a page of rows with no productId is a parse-error, not the end', [st.stop, st.pagesRead], ['parse-error', 1]);
  ok('lastErr names the shape', /no productId/.test(st.lastErr || ''), st.lastErr);
  ok('the verdict is not "all results"', JSON.parse(H.payload()).coverage.verdict !== 'exhausted-all-results');
  for (const [name, rep] of [['503', { url: 'https://he.aliexpress.com/w/x.html', status: 503, text: async () => '<html>busy</html>' }],
    ['login redirect', { url: 'https://login.aliexpress.com/signin.html?return=x', status: 200, text: async () => '<html>sign in</html>' }]]) {
    const G = loadHarvest(async () => rep);
    G.start({ query: 'wire brush set' });
    const g = await G.step(2);
    ok(`${name}: a fetch-error naming the cause, not parse-error`, g.stop === 'fetch-error' && /http 503|login\.aliexpress\.com\/signin/.test(g.lastErr || ''), JSON.stringify([g.stop, g.lastErr]));
    ok(`${name}: no "?" in status()`, !JSON.stringify(G.status()).includes('?'));
  }
  const J = loadHarvest(async () => reply('<html>/*init-data-start*/ x = { data: {"u":"/a?x=1","n":NaN} };</html>'));
  J.start({ query: 'wire brush set' });
  const j = await J.step(1);
  ok('a JSON error quoting a URL leaves no "?" in status()', j.stop === 'parse-error' && !JSON.stringify(j).includes('?'), JSON.stringify(j.lastErr));
  // Carry-over of a state from an older install: it gets a start time.
  const ls = fakeStorage();
  const win = { localStorage: ls };
  new Function('window', 'fetch', harvestSrc)(win, pageFetch({ 1: ['c1'], 2: [] }));
  win.__aeHarvest.start({ query: 'cheese grater' });
  await win.__aeHarvest.step(3);
  delete win.__aeHarvest.st.startedAt; // as an older install left it
  new Function('window', 'fetch', 'return (' + harvestSrc + '\n)')(win, pageFetch({}));
  ok('a carried-over state gets a start time', win.__aeHarvest.st.startedAt > 0);
  ok('and is saved under a real key, not stamp 0', [...ls._m.keys()].some((k) => k.startsWith('__aeHarvest:cheese-grater:') && !k.endsWith(':0')));
});

console.log('\nW2 — persist(): only a FULL store prunes, oldest first; a failed save leaves no stale copy');
await block('W2', async () => {
  const mk = (failWith) => {
    const st = fakeStorage();
    const set = st.setItem;
    st.setItem = (k, v) => { if (failWith && k.includes('wire-brush-set')) { const e = new Error(failWith); e.name = failWith; throw e; } set(k, v); };
    return st;
  };
  const other = mk(null);
  other.setItem('__aeHarvest:keep-me:1', JSON.stringify({ query: 'keep me', items: [], savedAt: 1 }));
  const st2 = mk('SecurityError');
  st2._m.set('__aeHarvest:keep-me:1', other._m.get('__aeHarvest:keep-me:1'));
  const w = { localStorage: st2 };
  new Function('window', 'fetch', harvestSrc)(w, pageFetch({ 1: ['k1'], 2: [] }));
  w.__aeHarvest.start({ query: 'wire brush set' });
  const s = await w.__aeHarvest.step(3);
  eq('a non-quota error is reported', s.backup && s.backup.saved, false);
  ok('and deletes no other backup', st2._m.has('__aeHarvest:keep-me:1'));
  // Quota: older runs go one at a time, oldest first.
  const q = fakeStorage();
  const qset = q.setItem;
  let cap = 2400;
  q.setItem = (k, v) => { const used = [...q._m.entries()].reduce((a, [kk, vv]) => a + (kk === k ? 0 : vv.length), 0);
    if (used + String(v).length > cap) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; } qset(k, v); };
  q._m.set('__aeHarvest:old-a:' + (1).toString(36), 'x'.repeat(900));
  q._m.set('__aeHarvest:old-b:' + (2).toString(36), 'x'.repeat(900));
  const wq = { localStorage: q };
  new Function('window', 'fetch', harvestSrc)(wq, pageFetch({ 1: ['q1'], 2: [] }));
  wq.__aeHarvest.start({ query: 'wire brush set' });
  const sq = await wq.__aeHarvest.step(3);
  eq('a full store drops the OLDEST run first and keeps the newer one', [sq.backup.saved, q._m.has('__aeHarvest:old-a:1'), q._m.has('__aeHarvest:old-b:2')], [true, false, true]);
});

console.log('\nW3 — send(): in-app hint, held fetch with no backup, longer receiver reply');
await block('W3', async () => {
  const forms = [];
  const H = await harvestWith({ document: formDoc(forms) }, (url) => url.startsWith('http://127.0.0.1:')
    ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(reply(makePage({ items: [makeItem('s1')], finished: true }))));
  const m = await H.send(9999);
  ok('a refused fetch names the in-app browser and {via:"form"}', /in-app browser always does/.test(m) && /via:"form"/.test(m) && m.length < 1000, m);
  const H2 = await harvestWith({ document: formDoc([]) }, (url) => url.startsWith('http://127.0.0.1:')
    ? new Promise(() => {}) : Promise.resolve(reply(makePage({ items: [makeItem('s2')], finished: true }))));
  const m2 = await H2.send(9999, { timeoutMs: 20 });
  ok('a held fetch with no backup is UNCONFIRMED (it may still land)', /^UNCONFIRMED: the fetch is held/.test(m2), m2);
  const longPath = 'saved /private/tmp/' + 'd'.repeat(180) + '/harvest-wire-brush-set-2026-10-18T10-00-00-000Z.json (1234 chars, 3 items)';
  const H3 = await harvestWith({ document: formDoc([]) }, (url) => url.startsWith('http://127.0.0.1:')
    ? Promise.resolve({ status: 200, text: async () => longPath }) : Promise.resolve(reply(makePage({ items: [makeItem('s3')], finished: true }))));
  const m3 = await H3.send(9999);
  ok('a long saved path comes back whole', m3.includes('(1234 chars, 3 items)'), m3);
  ok('SKILL.md tells the operator to use {via: \'form\'} in both browsers', /In both browsers use `send\(8765, \{via: 'form'\}\)`/.test(skillSrc));
  // Live 2026-10-18: signed-in Chrome refused the loopback fetch (FETCH-ERROR) with the
  // receiver up, so "In Chrome, plain send(8765) is right" sent the operator the wrong way.
  ok('SKILL.md no longer says plain send(8765) is right in Chrome', !/In Chrome, plain\s+`send\(8765\)` is right/.test(skillSrc));
  ok('no SKILL.md example calls a bare send(8765) or send(<port>)', !/__aeHarvest\.send\((8765|<port>)\)/.test(skillSrc),
    (skillSrc.match(/__aeHarvest\.send\((8765|<port>)\)[^\n]*/g) || []).join(' | '));
  ok('a refused fetch names signed-in Chrome too', /signed-in Chrome/.test(m), m);
});

console.log('\nW4 — receiver.mjs: write errors, same-millisecond names, flag forms');
await block('W4', async () => {
  const dir = tmp('ae-rx-w4-');
  const rx = await startRx({ dir, port: 0 });
  const body = JSON.stringify({ query: 'same', items: [] });
  const rs = await Promise.all(Array.from({ length: 8 }, () => fetch('http://127.0.0.1:' + rx.port + '/harvest', { method: 'POST', body })));
  eq('eight posts at once are all saved', rs.map((r) => r.status), Array(8).fill(200));
  eq('as eight files (none overwritten)', fsx.readdirSync(dir).filter((f) => f.startsWith('harvest-same-')).length, 8);
  fsx.rmSync(dir, { recursive: true, force: true });
  const bad = await fetch('http://127.0.0.1:' + rx.port + '/harvest', { method: 'POST', body });
  eq('a write error answers 500', bad.status, 500);
  const alive = await fetch('http://127.0.0.1:' + rx.port + '/');
  eq('and the receiver stays up', alive.status, 200);
  await rx.close();
  const { spawn } = await import('node:child_process');
  const fp = String(await freePort());
  const cp = spawn('node', [join(HERE, 'receiver.mjs'), '--dir=' + tmp('ae-rx-w4b-'), '--port=' + fp, '--idle=5']);
  const line = await new Promise((res) => { let b = ''; cp.stdout.on('data', (d) => { b += d; if (b.includes('\n')) res(b); }); });
  ok('--name=value is read', line.includes(':' + fp + ' ') && /5 s idle/.test(line), line);
  cp.kill();
  const cp2 = spawn('node', [join(HERE, 'receiver.mjs'), '--dir', tmp('ae-rx-w4c-'), '--idel', '5']);
  const code = await new Promise((res) => cp2.on('exit', res));
  eq('an unknown flag exits 2', code, 2);
});

console.log('\nW5 — decode.mjs: CRLF and cut dumps, old off-query parts, changed streams, re-merge, cases');
await block('W5', async () => {
  const { assemble, mergePayloads, textsOf } = await import('./decode.mjs');
  const P = (q, ids, pages, verdict, extra = {}) => ({ query: q, source: 'harvest-paged', coverage: { verdict }, fourStar: true,
    pages: pages.map(([page, n]) => ({ page, n })), items: ids.map((id) => ({ id, title: 'wire brush ' + id, rating: 4.8, sold: 500 })), ...extra });
  const dump = (text) => 'Title\n' + text + '\nfooter';
  const payload = JSON.stringify(P('wire brush set', ['a'], [[1, 1], [2, 0]], 'exhausted-all-results'));
  const lf = dump('AEPAYLOAD 0/1 abc START\n' + payload + '\nAEPAYLOAD END');
  const crlf = lf.split('\n').join(String.fromCharCode(13) + '\n');
  eq('a CRLF dump decodes', assemble([crlf]).payload.items.length, 1);
  let err = '';
  try { assemble([JSON.stringify(P('other', ['z'], [[1, 1]], 'truncated')), lf.slice(0, lf.length - 30)]); } catch (e) { err = String(e); }
  ok('a cut dump next to another payload is an error, not a silent drop', /no matching "AEPAYLOAD END"/.test(err), err);
  const old = { query: 'wired usb mouse', source: 'harvest-paged', coverage: { verdict: 'exhausted-all-results' }, fourStar: true,
    pages: [{ page: 1, n: 282 }, { page: 2, n: 0 }], items: realTitles.craftWire.titles.map((t, i) => ({ id: 'w' + i, title: t, rating: 4.8, sold: 500 })) };
  const good = { query: 'usb mouse', source: 'harvest-paged', coverage: { verdict: 'truncated' }, fourStar: true,
    pages: [{ page: 1, n: 326 }], items: realTitles.mice.titles.map((t, i) => ({ id: 'm' + i, title: t, rating: 4.8, sold: 500 })) };
  const m = mergePayloads([old, good]);
  eq('an old off-query part (no verdict of its own) makes the merge off-query', m.coverage.verdict, 'off-query');
  const early = P('wire brush set', ['a1', 'a2', 'a3'], [[1, 1], [2, 1], [3, 1], [4, 0]], 'exhausted-all-results');
  const later = P('wire brush set', ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'], [[1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1]], 'truncated');
  const ch = mergePayloads([early, later]);
  eq('a part that read past the dry page: the stream changed, truncated', ch.coverage.verdict, 'truncated');
  ok('named stream-changed', ch.warnings.some((w) => /^stream-changed/.test(w)));
  const a = P('wire brush set', ['a'], [[1, 1], [2, 1]], 'truncated', { filterKey: 'k1' });
  const b = P('wire brush set', ['b'], [[3, 1], [4, 1]], 'truncated', { filterKey: 'k1' });
  const c = P('wire brush set', ['c'], [[5, 1], [6, 0]], 'exhausted-from-start-page', { filterKey: 'k1' });
  const ab = mergePayloads([a, b]);
  eq('a merged file merged again gives the same verdict as one merge', mergePayloads([ab, c]).coverage.verdict, mergePayloads([a, b, c]).coverage.verdict);
  eq('which is complete', mergePayloads([ab, c]).coverage.verdict, 'exhausted-all-results');
  const upper = { ...b, query: 'Wire Brush Set' };
  eq('a query differing only in case is the same stream', mergePayloads([a, upper, c]).coverage.verdict, 'exhausted-all-results');
  const o1 = P('wire brush set', ['x'], [[1, 1], [2, 1]], 'truncated', { extraApplied: true });
  const o2 = P('wire brush set', ['y'], [[1, 1], [2, 1], [3, 1], [4, 0]], 'exhausted-all-results', { extraApplied: true });
  eq('two OLD payloads with unknown extras never join', mergePayloads([o1, o2]).coverage.byQuery.length, 2);
  const bl = { ...P('wire brush set', ['a'], [[1, 1], [2, 1]], 'truncated', { filterKey: 'k1' }), blocked: true };
  const done = P('wire brush set', ['b'], [[3, 1], [4, 0]], 'exhausted-from-start-page', { filterKey: 'k1' });
  const mb = mergePayloads([bl, done]);
  eq('a wall cleared by a later part: not blocked', [mb.blocked, mb.coverage.verdict], [false, 'exhausted-all-results']);
  ok('but named', mb.warnings.some((w) => /^wall-cleared/.test(w)));
  let e6 = '';
  try { assemble([dump('AEPAYLOAD 0/1 q1 START\n{"err":"not started"}\nAEPAYLOAD END')]); } catch (e) { e6 = String(e); }
  ok('a chunk set that is not a payload is refused', /not a harvest payload/.test(e6), e6);
  const inApp = JSON.stringify([{ type: 'text', text: JSON.stringify(JSON.stringify(P('q', ['a'], [[1, 1]], 'truncated'))).slice(0, 200) }]);
  const t0 = Date.now();
  let e9 = '';
  try { assemble(textsOf(inApp)); } catch (e) { e9 = String(e); }
  void t0;
  ok('a cut in-app result is named as cut', /is cut: its JSON string never closes/.test(e9), e9);
  ok('SKILL.md: only decode.mjs gives a merged verdict', /Only `decode.mjs`\s+gives a merged verdict/.test(skillSrc));
});

console.log('\nW6 — relevance: no prefix matches, irregular plurals, one count per keyword, other languages');
await block('W6', async () => {
  const { queryRelevance: qr } = await import('./lib.mjs');
  const water = Array.from({ length: 10 }, (_, i) => 'Waterproof Garden Furniture Cover ' + i);
  ok('"water bottle" over waterproof covers is off-query ("water" is not "waterproof")', qr('water bottle', water).warning !== null);
  ok('"tablet holder" over tables is off-query', qr('tablet holder', Array(8).fill('Folding Table Outdoor')).warning !== null);
  eq('"mice" on the real mouse stream raises nothing', qr('mice', realTitles.mice.titles).warning, null);
  eq('"pc mice" too', qr('pc mice', realTitles.mice.titles).warning, null);
  ok('the real craft-wire stream is still off-query for "wired usb mouse"', qr('wired usb mouse', realTitles.craftWire.titles).warning !== null);
  eq('"kitchen knife" over knives raises nothing', qr('kitchen knife', ['Knives Set 5pcs', 'Chef Knives', 'Steak Knives', 'Paring Knives', 'Bread Knives']).warning, null);
  eq('"magnifying glass" over magnifiers raises nothing', qr('magnifying glass', ['Magnifier 10X', 'Reading Magnifier', 'LED Magnifier', 'Loupe Magnifier', 'Magnifying Glass']).warning, null);
  eq('a repeated keyword is counted once', qr('usb c to usb c cable', ['USB C Cable', 'USB Hub']).keywords, ['usb', 'cable']);
  eq('Spanish titles are unmeasured, not off-query', qr('wireless mouse', ['Ratón inalámbrico para PC', 'Ratón con USB', 'Ratón para portátil',
    'Ratón ergonómico para oficina', 'Ratón silencioso con receptor']).reason, 'titles-not-english');
});

console.log('\nW7 — rank.mjs: why the ranking is empty, flags, pipes, ties in a tier, numbers');
await block('W7', async () => {
  const unk = Array.from({ length: 4 }, (_, i) => ({ id: 'u' + i, title: 'x', rating: 4.8, ownRating: 4.8, reviews: 300, sold: 5000, constraints: { wired: 'unknown' } }));
  const r1 = rank(unk, ['--mode', 'final', '--constraint', 'wired']);
  ok('all unknown: the note says unverified, not "no candidate satisfies"', /VERIFIED/.test(r1.note) && !r1.warnings.some((w) => /^no candidate satisfies/.test(w)), r1.note);
  const noOwn = unk.map((x) => ({ ...x, reviews: null, ownRating: null, constraints: { wired: 'pass' } }));
  const r1b = rank(noOwn, ['--mode', 'final', '--constraint', 'wired']);
  ok('all dropped for no own count: not "no candidate satisfies"', !/no candidate satisfies/.test(r1b.note), r1b.note);
  const fail = unk.map((x) => ({ ...x, constraints: { wired: 'fail' } }));
  const r1c = rank(fail, ['--mode', 'final', '--constraint', 'wired']);
  eq('all failing: that IS "no candidate satisfies", with the count', [r1c.note, r1c.constraintViolations], ['no candidate satisfies the stated constraints', 4]);
  const runRaw = (input, args) => execFileSync('node', [RANK, ...args], { input: JSON.stringify(input), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  let code = 0;
  try { runRaw(fail, ['--mode', 'final', '--constriant', 'wired']); } catch (e) { code = e.status; }
  eq('an unknown flag exits 2', code, 2);
  const eqForm = JSON.parse(runRaw(unk, ['--mode=final', '--top=2']));
  eq('--name=value is read', [eqForm.mode, eqForm.ranked.length], ['final', 2]);
  code = 0;
  try { runRaw(unk, ['--mode', 'final', '--min-evidence', '']); } catch (e) { code = e.status; }
  eq('a blank value exits 2', code, 2);
  code = 0;
  try { runRaw(unk, ['--mode', 'final', '--w-quality', '0', '--w-volume', '0']); } catch (e) { code = e.status; }
  eq('weights adding up to 0 exit 2 (they made every score NaN)', code, 2);
  // Piped output of an empty ranking past 64 KiB comes back whole.
  const big = Array.from({ length: 400 }, (_, i) => ({ id: 'b' + i, title: 'item ' + 'z'.repeat(150), rating: 4.8, sold: 500 }));
  const outText = runRaw(big, ['--mode', 'shortlist', '--require', 'nothing-matches-this']);
  ok('an empty ranking over 64 KiB is complete on a pipe', outText.length > 65536 && !!JSON.parse(outText), String(outText.length));
  const tier = [...Array.from({ length: 6 }, (_, i) => ({ id: 'h' + i, title: 'x', rating: 4.9, sold: 10000, soldBucketed: true })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: 'lo' + i, title: 'x', rating: 4.8, sold: 600 }))];
  const r6 = rank(tier, ['--mode', 'shortlist', '--top', '4', '--spread', '1']);
  ok('a tie inside a spread tier is named', r6.warnings.some((w) => /^tie-in-spread/.test(w)), JSON.stringify(r6.warnings));
  const r9 = rank([{ id: 'p', title: 'x', rating: 3.9, reviews: null, pooledReviews: 5000, sold: 5000 }], ['--mode', 'final']);
  eq('no own count: own-reviews-unknown, not judged on the pooled rating', r9.droppedReasons, { 'own-reviews-unknown': 1 });
  const r10 = rank([{ id: 'f', title: 'x', rating: 4.9, ownRating: 4.9, reviews: 2500, sold: 10000, brandScore: 0 },
    { id: 'g', title: 'y', rating: 4.8, ownRating: 4.8, reviews: 900, sold: 5000 }], ['--mode', 'final']);
  ok('a brandScore under 0.2 is flagged brand-implausible', r10.ranked.find((x) => x.id === 'f').flags.includes('brand-implausible'));
  const r11 = rank([], ['--mode', 'shortlist']);
  ok('an empty input says so', r11.warnings.some((w) => /^empty-input/.test(w)), JSON.stringify(r11.warnings));
  const r12 = rank([{ id: 'o', title: 'x', rating: 4.9, reviews: { own: 300 }, sold: 5000 }, { id: 'n', title: 'y', rating: 4.8, reviews: 300, sold: 5000 }], ['--mode', 'final']);
  ok('a reviews OBJECT is set aside by name', r12.droppedReasons['not-a-number:reviews'] === 1 && r12.warnings.some((w) => /^not-a-number/.test(w)), JSON.stringify(r12.droppedReasons));
  ok('and the others score normally', r12.ranked[0].volume === 1, JSON.stringify(r12.ranked[0]));
});

console.log('\nW8 — listing.js and the step-5 reader (stub DOM; the real-Chromium cases are in the review notes)');
await block('W8', async () => {
  const src = RUN('listing.js');
  const el = (tag, p = {}) => {
    const e = { tagName: tag, children: p.children || [], textContent: p.text || '', className: p.cls || '', naturalWidth: 0, naturalHeight: 0,
      currentSrc: '', src: '', shadowRoot: null, parentElement: p.parent || null, getAttribute: (k) => (p.attrs || {})[k] || null,
      querySelector: () => null, querySelectorAll: () => p.qsa || [], closest: () => null, click() {}, id: '', nodeType: 1,
      previousElementSibling: p.prev || null,
      childNodes: p.nodes || (p.text ? [{ nodeType: 3, nodeValue: p.text }] : []) };
    return e;
  };
  const run = async (els, bodyText = 'x'.repeat(2500), opts = { description: false }, ld = 0, win = {}) => {
    const document = { body: { scrollHeight: 5000, innerText: bodyText }, documentElement: { outerHTML: '' },
      querySelectorAll: (sel) => (/ld\+json/.test(sel || '') ? new Array(ld) : els) };
    return new Function('window', 'document', 'location', `${src}; return window.__aeListing;`)({ scrollTo() {}, document, ...win }, document,
      { href: 'https://he.aliexpress.com/item/1.html' }).read(opts);
  };
  const sz = (r) => [r.productSizeLines, r.packageSizeLines];
  eq('"Packaging size" is the carton', sz(await run([el('P', { text: 'Packaging size: 30 x 20 x 10 cm' })])), [[], ['Packaging size: 30 x 20 x 10 cm']]);
  eq('"Box size" is the carton', sz(await run([el('P', { text: 'Box size: 30 x 20 x 10 cm' })])), [[], ['Box size: 30 x 20 x 10 cm']]);
  eq('two sizes on one line are judged one by one', sz(await run([el('P', { text: 'Product size: 12 x 6 x 4 cm / Package size: 20 x 10 x 6 cm' })])),
    [['Product size: 12 x 6 x 4 cm'], ['Package size: 20 x 10 x 6 cm']]);
  eq('"Package: 1 x Mouse. Size: 12 x 6 x 4 cm." is a product size', sz(await run([el('P', { text: 'Package: 1 x Mouse. Size: 12 x 6 x 4 cm. Color: Black' })])),
    [['Size: 12 x 6 x 4 cm'], []]);
  eq('an inch-mark size is read', sz(await run([el('P', { text: 'Size: 7.9" x 3.1" x 1.2"' })]))[0], ['Size: 7.9" x 3.1" x 1.2"']);
  eq('"22cm (L) x 12cm (W) x 28cm (H)" is read', sz(await run([el('P', { text: 'Size: 22cm (L) x 12cm (W) x 28cm (H)' })]))[0], ['Size: 22cm (L) x 12cm (W) x 28cm (H)']);
  const strong = el('STRONG', { text: 'Size:', children: [el('SPAN', { text: 'Size:' })] });
  const p5 = el('P', { text: 'Size: 22 x 12 x 28 cm', children: [strong], nodes: [strong, { nodeType: 3, nodeValue: ' 22 x 12 x 28 cm' }] });
  eq('<p><strong><span>Size:</span></strong> 22 x 12 x 28 cm</p> is one line', sz(await run([p5, strong]))[0], ['Size: 22 x 12 x 28 cm']);
  const lab = el('TD', { text: 'Size' });
  const val = el('TD', { text: '12 x 6 x 4 cm', prev: lab, parent: { textContent: 'Package1 pcSize12 x 6 x 4 cm' } });
  eq('a bare value takes the label of the cell before it', sz(await run([lab, val])), [['12 x 6 x 4 cm'], []]);
  const pl = el('SPAN', { text: 'גודל החבילה:' });
  const pv = el('SPAN', { text: '12x7x4 סמ', prev: pl });
  eq('in a shadow root (no parent element) too', sz(await run([pl, pv])), [[], ['12x7x4 סמ']]);
  const spans = [el('SPAN', { text: 'Package' }), el('SPAN', { text: '1 pc' })];
  const div = el('DIV', { text: 'Package1 pc', children: spans, nodes: spans });
  const r7 = await run([div, ...spans]);
  ok('a <div> of <span>s with no text of its own is not one glued line', !r7.sizeLines.some((l) => /Package1 pc/.test(l.text)));
  const slide = el('DIV', { cls: 'slick-slide' });
  const reco = el('DIV', { text: 'Gaming Mouse Pad Size 80x30cm', parent: slide });
  eq('a carousel title is never this product\'s size', sz(await run([reco, el('P', { text: 'Size: 12 x 6 x 4 cm' })]))[0], ['Size: 12 x 6 x 4 cm']);
  const rv = await run([], 'Great grater. Please slide the drum in until it clicks before use. ' + 'x'.repeat(2500), { description: false }, 1);
  eq('a review saying "please slide" on a page with JSON-LD is not a wall', rv.blocked, false);
  const DESC = 'https://pdp.aliexpress-media.com/product/description/pc/v2/he_IL/desc.htm?productId=1';
  const dwin = (body) => ({ performance: { getEntriesByType: () => [{ name: DESC }] },
    fetch: async () => ({ url: DESC, status: 200, text: async () => '<html>' + body + '</html>' }),
    DOMParser: class { parseFromString() { const p = el('P', { text: body }); return { body: el('BODY', { qsa: [p], nodes: [p] }), querySelectorAll: () => [p] }; } } });
  const he = await run([], 'x'.repeat(2500), {}, 0, dwin('אנא החלק את המחוון ימינה כדי לאמת שאתה לא רובוט. תודה על הסבלנות שלך.'));
  eq('the Hebrew imperative wall is a wall', [he.description.source, he.blocked], ['blocked', true]);
  const js = await run([], 'x'.repeat(2500), {}, 0, dwin('{"success":false,"code":"TOKEN_EXPIRED"}'));
  eq('a JSON error answer is fetch-failed', js.description.source, 'fetch-failed');
  const short = await run([], 'x'.repeat(2500), {}, 0, dwin('Size: 12 x 6 x 4 cm'));
  eq('a short real description is still fetched', short.description.source, 'fetched');
  const st = await run([], 'Specifications\nDescription\nx\nSpecifications\nApplication\nStore display\nType\nWired\nStore\n' + 'y'.repeat(2500));
  eq('spec rows: a value "Store display" is not the "Store" heading; a tab label is skipped', st.specs, { Application: 'Store display', Type: 'Wired' });
  const raw = await run([], 'מפרטים\nתיאור\nx\nמפרטים\nשם המותג\nNONE\nתיאור\n' + 'y'.repeat(2500));
  eq('text-raw keeps the block with lines, not the tab label', [raw.specsSource, raw.specsText], ['text-raw', 'שם המותג | NONE']);
  const longName = 'X7 Wireless Rechargeable Silent Mouse 2.4G Bluetooth Dual Mode Black';
  const r9 = await run([el('DIV', { cls: 'sku-item--text--Q sku-item--selected--I', text: longName })]);
  eq('a long selected option is kept, not dropped', r9.selectedVariants, [longName]);
  // Step-5 reader
  const optEl = (name, sel) => ({ className: 'sku-item--text--Qa1' + (sel ? ' sku-item--selected--I' : ''), querySelector: () => null, textContent: name, shadowRoot: null });
  const ldj = [{ textContent: JSON.stringify({ '@type': 'Product', aggregateRating: { ratingValue: '4.9', reviewCount: '5479' }, offers: { price: '3.1', priceCurrency: 'USD' } }) }];
  const s5 = (els, text) => JSON.parse(new Function('document', 'location', 'return (' + step5 + '\n)')(
    { title: 'Mouse', body: { innerText: text || RV.gyro }, querySelectorAll: (sel) => (/ld\+json/.test(sel) ? ldj : els) }, { pathname: '/item/1.html' }));
  const g = s5(['Black', 'White', 'Grey'].map((c, i) => optEl('Bluetooth Rechargeable ' + c, i === 2)));
  eq('options are deduped on the whole name and keep both ends', [g.optionCount, g.options.length, g.options.some((o) => /Grey\*$/.test(o))], [3, 3, true]);
  const g2 = s5([], 'x\nSpecifications\nType\nInterface Type\nUSB\nPower Type\nBattery\nDescription\n' + RV.gyro);
  eq('step 5: an empty value does not take the next name', g2.spec, { Type: '', 'Interface Type': 'USB', 'Power Type': 'Battery' });
  const g3 = s5([], 'Customer Reviews\nSpecifications\nDescription\n' + 'r\n'.repeat(5) + 'Specifications\nPower Type\nUSB\nDescription\nType\nMouse for gaming');
  eq('step 5: the scan stops at a heading and skips a tab label', g3.spec, { 'Power Type': 'USB' });
  const many = Array.from({ length: 30 }, (_, i) => optEl('Option ' + i + ' ' + 'n'.repeat(30), i % 3 === 0));
  const longSpec = '<div>';
  void longSpec;
  const raw5 = new Function('document', 'location', 'return (' + step5.replace(/const WANT = \[[^\]]*\];/, "const WANT = ['Type','Interface Type','Power Type','Battery Included','Connection','Cable Length','Material','Model Number'];") + '\n)')(
    { title: 'Mouse', body: { innerText: RV.gyro }, querySelectorAll: (sel) => (/ld\+json/.test(sel) ? ldj : many.concat(['Type', 'Interface Type', 'Power Type', 'Battery Included', 'Connection', 'Cable Length', 'Material', 'Model Number']
      .map((k) => ({ className: 'specification--prop--J', shadowRoot: null, textContent: k, querySelector: (q) => (/title/.test(q) ? { textContent: k } : { textContent: 'v'.repeat(60) }) })))) },
    { pathname: '/item/1.html' });
  ok('step 5 never passes 1,000 characters, and says when options were cut', raw5.length <= 1000 && JSON.parse(raw5).optionsCut === true, String(raw5.length));
});

console.log('\nW9 — extract.js: a short card does not take its neighbour\'s data');
await block('W9', async () => {
  const exSrc = RUN('extract.js');
  const grid = { textContent: '', parentElement: null };
  const mkCard = (id, text) => {
    const card = { textContent: text, parentElement: grid, querySelectorAll: () => [{ href: 'https://he.aliexpress.com/item/' + id + '.html' }] };
    return { href: 'https://he.aliexpress.com/item/' + id + '.html', parentElement: card };
  };
  const a = mkCard('1007', 'Wireless Mouse 2.4G Silent Rechargeable Ergonomic Office Mouse 4.95,000+ נמכרו ₪22.30');
  const b = mkCard('1008', 'Mouse pad small cheap one ₪9.90 משלוח חינם');
  grid.textContent = a.parentElement.textContent + b.parentElement.textContent;
  grid.querySelectorAll = () => [a, b];
  const out = JSON.parse(new Function('window', 'document', 'location', 'return (' + exSrc + '\n)')({},
    { querySelectorAll: (sel) => (/ld\+json/.test(sel) ? [] : [a, b]), body: { innerText: 'x'.repeat(3000) }, documentElement: { outerHTML: '' }, title: 't' },
    { href: 'https://he.aliexpress.com/w/x.html', origin: 'https://he.aliexpress.com', pathname: '/w/x.html', search: '' }));
  const card = out.items.find((i) => i.id === '1008');
  ok('the short card keeps its own price and no borrowed rating', card && card.price === 9.9 && card.rating === null, JSON.stringify(card));
});

console.log('\nW10 — build.mjs: postfix ++ / 2, o.return / 2, multi-line templates, and the same-program check');
await block('W10', async () => {
  const { strip, sameProgram, buildSource } = await import('./build.mjs');
  const t = "var i = 3; const avg = i++ / 2, label = 'a/b', open = '/*'; var tail = 'changed'; const close = '*/';";
  eq('"i++ / 2" is a division: nothing after it is lost', new Function(strip(t) + ' return [avg, label, open, tail, close];')(), [1.5, 'a/b', '/*', 'changed', '*/']);
  const o = 'var o = { return: 4 }; var x = o.return / 2 / 1;';
  eq('"o.return / 2" is a division', new Function(strip(o) + ' return x;')(), 2);
  let e = '';
  try { buildSource('x.js', 'var s = `a\nb`;'); } catch (er) { e = String(er); }
  ok('a template literal across lines is refused', /spans lines/.test(e), e);
  eq('the same-program check sees a dropped statement', sameProgram('var a = 1; var b = 2;', 'var a = 1;'), false);
  eq('and passes the real sources against their dist copies', ['harvest.js', 'listing.js', 'extract.js']
    .map((n) => sameProgram(SRC(n), readFileSync(join(HERE, 'dist', n.replace(/\.js$/, '.min.js')), 'utf8'))), [true, true, true]);
});

console.log('\nW11 — the shared blocks are the same CODE as lib.mjs, not only the same answers');
await block('W11', async () => {
  const { strip } = await import('./build.mjs');
  const norm = (code) => strip(code).replace(/\s+/g, ' ').trim();
  const libText = SRC('lib.mjs');
  const blockOf = (text, name) => (text.match(new RegExp('/\\* @shared:' + name + ':start \\*/([\\s\\S]*?)/\\* @shared:' + name + ':end \\*/')) || [])[1];
  const pairs = [['parseSold', ['harvest.js', 'extract.js']], ['soldRe', ['harvest.js', 'extract.js']], ['wallVerdict', ['harvest.js', 'extract.js', 'listing.js']],
    ['queryRelevance', ['harvest.js']], ['reviewBlock', ['listing.js']]];
  for (const [name, files] of pairs) {
    const want = norm(blockOf(libText, name) || '');
    for (const f of files) {
      const got = norm(blockOf(SRC(f), name) || '');
      let at = 0;
      while (at < got.length && got[at] === want[at]) at++;
      ok(`${f} @shared:${name} is lib.mjs's code`, got === want,
        `first difference at char ${at}: copy "${got.slice(Math.max(0, at - 30), at + 30)}" vs lib "${want.slice(Math.max(0, at - 30), at + 30)}"`);
    }
  }
  const s5blk = (name) => norm(blockOf(step5 || '', name) || '');
  eq('SKILL.md step 5 @shared:reviewBlock is lib.mjs\'s code', s5blk('reviewBlock'), norm(blockOf(libText, 'reviewBlock')));
  eq('SKILL.md step 5 @shared:soldRe is lib.mjs\'s code', s5blk('soldRe'), norm(blockOf(libText, 'soldRe')));
});

console.log('\nW12 — doc numbers match the files');
await block('W12', async () => {
  const kb = (f) => Math.round(readFileSync(join(HERE, f), 'utf8').length / 1000);
  const m = skillSrc.match(/\(about (\d+) KB instead of (\d+) KB\)/);
  ok('SKILL.md states the install sizes', !!m);
  ok('and they are the harvest.js sizes (within 3 KB)', m && Math.abs(Number(m[1]) - kb('dist/harvest.min.js')) <= 3 && Math.abs(Number(m[2]) - kb('harvest.js')) <= 3,
    JSON.stringify([m && m.slice(1), kb('dist/harvest.min.js'), kb('harvest.js')]));
  ok('SKILL.md says ~200 KB per 400 items (about 500 chars per item, measured)', /~200 KB per 400 items/.test(skillSrc));
  ok('a page-cap is lifted with resume({ maxPages })', /`resume\(\{ maxPages \}\)`/.test(skillSrc));
  ok('the listing.js read order says blocked first', /read `blocked` \/ `suspectedWall` first/.test(skillSrc));
});

// ============================================================================
// 2026-10-18, recheck: three skeptics each confirmed these on the code of
// the fourth pass (harvest relevance, backups, the page-60 cap, the export
// wording). Each block below fails on that code.
// ============================================================================
const recheckRep = (t, n = 10) => Array.from({ length: n }, (_, i) => t + ' ' + i);
const recheckInstall = () => new Function('window', 'fetch', 'return (' + harvestSrc + '\n)')({}, async () => reply(''));

console.log('\nR-F00: relevance: a noun ending in -ss and its plural are one word');
await block('R-F00', async () => {
  const { queryRelevance: qr } = await import('./lib.mjs');
  for (const [q, t] of [['dresses', 'Women Summer Floral Dress'], ['dress', 'Women Summer Floral Dresses'],
    ['glass', 'Wine Glasses Crystal'], ['glasses', 'Wine Glass Crystal'], ['mattresses', 'Memory Foam Mattress'],
    ['compass', 'Hiking Compasses'], ['neck ties', 'Mens Silk Tie Necktie']]) {
    eq(`R-F00: "${q}" over "${t}" titles raises nothing`, qr(q, recheckRep(t)).warning, null);
  }
  eq('R-F00: "wine glasses" over "Wine Glass" gives the noun its share', qr('wine glasses', recheckRep('Wine Glass')).keywordShare,
    { wine: 1, glasses: 1 });
  // The same through the harvester, so the inlined copy is exercised too.
  const items = Array.from({ length: 6 }, (_, i) => makeItem('g' + i, { title: 'Crystal Wine Glasses ' + i }));
  const H = loadHarvest(async (url) => { const p = Number(new URL(url).searchParams.get('page'));
    return reply(makePage({ items: p === 1 ? items: [], page: p })); });
  H.start({ query: 'wine glass' });
  await H.step(3);
  const pl = JSON.parse(H.payload());
  eq('R-F00: harvest.js gives "glass" its share on "Glasses" titles', pl.relevance.keywordShare, { wine: 1, glass: 1 });
  // What must not change: a word that only starts the same is another word.
  ok('R-F00: "dress" is still not "address"', qr('dress', recheckRep('Address Label Sticker')).warning !== null);
});

console.log('\nR-F20: relevance: short plurals (toys, cars, boxes, buses, ties) match');
await block('R-F20', async () => {
  const { queryRelevance: qr } = await import('./lib.mjs');
  for (const [q, t] of [['toy car', 'Kids Toys Cars'], ['box', 'Storage Boxes'], ['cup', 'Coffee Cups'], ['bags', 'Shopping Bag'],
    ['bag', 'Shopping Bags'], ['pen', 'Gel Pens'], ['hat', 'Sun Hats'], ['tie', 'Silk Ties'], ['bus', 'Model Buses'], ['buses', 'Toy Bus']]) {
    eq(`R-F20: "${q}" over "${t}" titles raises nothing`, qr(q, recheckRep(t)).warning, null);
  }
  // The finding's end-to-end case: start({query:'dress'}) on a stream of Dresses.
  const items = Array.from({ length: 6 }, (_, i) => makeItem('d' + i, { title: 'Women Summer Floral Dresses ' + i, soldRaw: '1,000+' }));
  const H = loadHarvest(async (url) => { const p = Number(new URL(url).searchParams.get('page'));
    return reply(makePage({ items: p === 1 ? items: [], page: p })); });
  H.start({ query: 'dress' });
  const st = await H.step(3);
  eq('R-F20: status().relevance is on-query', [st.relevance.share, st.relevance.offQuery], [1, false]);
  const pl = JSON.parse(H.payload());
  eq('R-F20: the verdict is exhausted-all-results, not off-query', pl.coverage.verdict, 'exhausted-all-results');
  const r = rank(pl, ['--mode', 'shortlist']);
  ok('R-F20: rank.mjs raises no off-query warning', !r.warnings.some((w) => /^off-query-results/.test(w)), JSON.stringify(r.warnings));
  // What must not change.
  ok('R-F20: "wire" is still not "wired"', qr('wired usb mouse', recheckRep('Aluminum Craft Wire 20 Gauge')).warning !== null);
  ok('R-F20: "car" is still not "card"', qr('car', recheckRep('Gift Card Holder')).warning !== null);
  ok('R-F20: "pen" is still not "pendant"', qr('pen', recheckRep('Silver Pendant Necklace')).warning !== null);
});

console.log('\nR-F25: relevance: "pour", "les", "con" alone do not make an English title foreign');
await block('R-F25', async () => {
  const { queryRelevance: qr } = await import('./lib.mjs');
  const kettles = qr('wired usb mouse', recheckRep('Pour Over Coffee Kettle Gooseneck', 20));
  eq('R-F25: English titles with "pour" are measured', [kettles.measured, kettles.checked], [true, 20]);
  ok('R-F25: so an off stream of pour-over kettles is flagged', kettles.warning !== null, JSON.stringify(kettles).slice(0, 200));
  for (const [q, t] of [['electric guitar', 'Les Paul Electric Guitar'], ['con rod', 'Con Rod Bearing Set'],
    ['paracord', 'Para Cord 550 Paracord'], ['calculator', 'Sin Cos Scientific Calculator']]) {
    eq(`R-F25: "${t}" titles are measured and on-query`, [qr(q, recheckRep(t)).measured, qr(q, recheckRep(t)).warning], [true, null]);
  }
  // Other languages stay unmeasured.
  eq('R-F25: German titles with "mit" stay unmeasured', qr('wireless mouse', recheckRep('Kabellose Maus mit USB')).reason, 'titles-not-english');
  eq('R-F25: French titles with "sans" stay unmeasured', qr('wireless mouse', recheckRep('Souris sans fil pour PC')).reason, 'titles-not-english');
  eq('R-F25: Spanish titles with two such words stay unmeasured', qr('wireless mouse', recheckRep('Mouse inalambrico para PC con cable')).reason,
    'titles-not-english');
  eq('R-F25: one such word beside an accented letter is foreign', qr('wireless mouse', recheckRep('Ratón inalámbrico para PC')).reason,
    'titles-not-english');
  ok('R-F25: SKILL.md says one of those words counts only beside a second one or an accent',
    /so one of them counts only beside a second one\s+or a letter with an accent/.test(skillSrc));
});

console.log('\nR-F32: relevance: split compounds match; a synonym is named as the limit');
await block('R-F32', async () => {
  const { queryRelevance: qr } = await import('./lib.mjs');
  const sd = [...recheckRep('Screw Driver Kit Magnetic', 40), ...recheckRep('Torx Bit Holder', 20)];
  const r1 = qr('screwdriver set', sd);
  eq('R-F32: "screwdriver set" over "Screw Driver" titles raises nothing', r1.warning, null);
  eq('R-F32: and "screwdriver" gets its share', r1.keywordShare.screwdriver, 0.667);
  eq('R-F32: "screw driver" over "Screwdriver" titles raises nothing', qr('screw driver', recheckRep('Precision Screwdriver Set')).warning, null);
  const eb = qr('earphones', recheckRep('Wireless Earbuds Bluetooth 5.3 TWS', 60));
  ok('R-F32: a synonym stream still warns (the documented limit)', eb.warning !== null);
  ok('R-F32: the warning quotes the titles that hold no keyword', eb.offSample.length === 3 && eb.offSample.every((t) => eb.warning.includes(t)),
    eb.warning);
  ok('R-F32: and says the check cannot see a synonym, and where the stream verdict is',
    /cannot see a synonym/.test(eb.warning) && /coverage\.streamVerdict/.test(eb.warning), eb.warning);
  ok('R-F32: SKILL.md says to read relevance.offSample before acting on off-query',
    /\*\*Read the off titles before you act on `off-query`\.\*\*/.test(skillSrc) && /first read `relevance\.offSample`/.test(skillSrc));
  ok('R-F32: SKILL.md names the synonym limit', /The check cannot see\s+a synonym/.test(skillSrc));
});

console.log('\nR-F02: backups are ranked by the time they were SAVED, not started');
await block('R-F02', async () => {
  const ls = fakeStorage();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const site = (q) => async (url) => { const p = Number(new URL(url).searchParams.get('page'));
    return reply(makePage({ items: p <= 8 ? [makeItem(q + p)]: [], page: p })); };
  const tab = (f) => { const w = { localStorage: ls }; new Function('window', 'fetch', harvestSrc)(w, f); return w.__aeHarvest; };
  const A = tab(site('db'));
  A.start({ query: 'drill bits', maxRequests: 2 });
  await A.step(6); // request-budget after 2 pages
  await wait(4);
  const B = tab(site('hk'));
  B.start({ query: 'hex keys' });
  await B.step(3);
  await wait(4);
  // A fresh tab restores the older run and reads on: it is saved last now.
  const C = tab(site('db'));
  C.restore('drill bits');
  C.resume({ maxRequests: 5 });
  await C.step(3);
  await wait(4);
  const D = tab(site('x'));
  const r = D.restore();
  eq('R-F02: restore() with no query takes the run saved last, not the one started last', [r.query, r.pagesRead], ['drill bits', 5]);
  eq('R-F02: backups() lists the run saved last first', D.backups().map((b) => b.query), ['drill bits', 'hex keys']);
  for (const q of ['q3', 'q4']) { await wait(4); tab(site(q)).start({ query: q }); }
  eq('R-F02: two newer starts drop the run saved longest ago, not the one worked on', D.backups().map((b) => b.query),
    ['q4', 'q3', 'drill bits']);
  // A full store: the quota loop drops the run saved longest ago first.
  const dry = fakeStorage();
  const wd = { localStorage: dry };
  new Function('window', 'fetch', harvestSrc)(wd, pageFetch({ 1: ['q1'], 2: [] }));
  wd.__aeHarvest.start({ query: 'wire brush set' });
  await wd.__aeHarvest.step(3);
  const saveLen = [...dry._m.values()][0].length;
  const filler = 'x'.repeat(800);
  const old1 = JSON.stringify({ v: 2, savedAt: Date.now() - 1000, query: 'worked on', items: [], pad: filler });
  const old2 = JSON.stringify({ v: 2, savedAt: 5, query: 'left alone', items: [], pad: filler });
  const cap = old1.length + old2.length + saveLen - 100;
  const q = fakeStorage();
  const qset = q.setItem;
  q.setItem = (k, v) => { const used = [...q._m.entries()].reduce((a, [kk, vv]) => a + (kk === k ? 0: vv.length), 0);
    if (used + String(v).length > cap) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; } qset(k, v); };
  q._m.set('__aeHarvest:worked-on:' + (1).toString(36), old1); // started first, saved a second ago
  q._m.set('__aeHarvest:left-alone:' + (2).toString(36), old2); // started later, saved long ago
  const wq = { localStorage: q };
  new Function('window', 'fetch', harvestSrc)(wq, pageFetch({ 1: ['q1'], 2: [] }));
  wq.__aeHarvest.start({ query: 'wire brush set' });
  const sq = await wq.__aeHarvest.step(3);
  eq('R-F02: a full store drops the run saved longest ago, and keeps the one saved a second ago',
    [sq.backup && sq.backup.saved, q._m.has('__aeHarvest:left-alone:2'), q._m.has('__aeHarvest:worked-on:1')], [true, false, true]);
  ok('R-F02: SKILL.md says the 3 runs saved last are kept', /the 3 runs\s+saved last are kept/.test(skillSrc) && !/the 3 newest\s+runs are kept/.test(skillSrc));
});

console.log('\nR-F03: maxPages stops at the site\'s page 60; an empty page 61 is never "all results"');
await block('R-F03', async () => {
  const fetched = [];
  const site = async (url) => { const p = Number(new URL(url).searchParams.get('page')); fetched.push(p);
    return reply(makePage({ items: p <= 60 ? [makeItem('wb' + p)]: [], page: p })); };
  const H = loadHarvest(site);
  const plan = H.start({ query: 'wire brush', maxPages: 70, maxRequests: 70 });
  eq('R-F03: maxPages above 60 is cut to 60', plan.maxPages, 60);
  ok('R-F03: and the plan says so', /cut to 60/.test(plan.note || ''), JSON.stringify(plan));
  let st = null;
  for (let k = 0; k < 20 && !(st && st.done); k++) st = await H.step(6);
  eq('R-F03: the run stops at page 60 as page-cap', [st.stop, st.pagesRead], ['page-cap', 60]);
  ok('R-F03: page 61 is never fetched', !fetched.includes(61), JSON.stringify(fetched.slice(-3)));
  const pl = JSON.parse(H.payload());
  eq('R-F03: the verdict is truncated, never exhausted-all-results', [pl.coverage.verdict, pl.coverage.streamVerdict], ['truncated', 'truncated']);
  const rs = H.resume({ maxPages: 80 });
  ok('R-F03: resume() cannot read past page 60', /serves no page past it/.test(rs.err || '') && rs.stop === 'page-cap', JSON.stringify(rs));
  // A backup written by older code: maxPages 70, read up to page 59.
  const ls = fakeStorage();
  ls.setItem('__aeHarvest:wire-brush:1', JSON.stringify({ v: 2, savedAt: Date.now(), query: 'wire brush', slug: 'wire-brush',
    base: 'https://he.aliexpress.com/w/wholesale-wire-brush.html?SortType=total_tranpro_desc', fourStar: true, extra: null, startPage: 1, maxPages: 70, maxRequests: 70,
    page: 59, requests: 59, items: [], pages: [], claimedTotal: null, stop: 'request-budget', endSignal: null, lastErr: null, wall: null, startedAt: 1 }));
  const w = { localStorage: ls };
  fetched.length = 0;
  new Function('window', 'fetch', harvestSrc)(w, site);
  w.__aeHarvest.restore();
  w.__aeHarvest.resume();
  const s2 = await w.__aeHarvest.step(6);
  eq('R-F03: a restored maxPages 70 still stops at page 60', [s2.stop, s2.pagesRead, fetched], ['page-cap', 60, [60]]);
  const r2 = H.resume({ maxRequests: 99 });
  ok('R-F03: a raised budget cannot lift the page-60 stop either', /serves no page past it/.test(r2.err || ''), JSON.stringify(r2));
  let threw = '';
  try { H.start({ query: 'x', startPage: 61 }); } catch (e) { threw = String(e); }
  ok('R-F03: a startPage past 60 is refused', /past page 60/.test(threw), threw);
  ok('R-F03: SKILL.md says a maxPages above 60 is cut to 60', /a `maxPages` above 60 is\s+cut to 60/.test(skillSrc));
});

console.log('\nR-F07: the install reply and the receiver header name send(8765, {via:\'form\'})');
await block('R-F07', async () => {
  const msg = recheckInstall();
  ok('R-F07: the install reply names send(8765, {via:\'form\'})', /await __aeHarvest\.send\(8765, \{via:'form'\}\)/.test(msg), msg);
  ok('R-F07: after the curl check', /curl -s http:\/\/127\.0\.0\.1:8765\/ answers ok\), then await __aeHarvest\.send\(8765, \{via/.test(msg), msg);
  ok('R-F07: and never a plain __aeHarvest.send(8765)', !/__aeHarvest\.send\(8765\)/.test(msg), msg);
  ok('R-F07: the install reply fits the Chrome cap and has no "?"', msg.length < 1000 && !msg.includes('?'), String(msg.length));
  const rx = SRC('receiver.mjs');
  ok('R-F07: the receiver.mjs header names {via: \'form\'} and the curl check',
    /`await __aeHarvest\.send\(<port>, \{via: 'form'\}\)`\s+\* after `curl -s http:\/\/127\.0\.0\.1:<port>\/` answers ok/.test(rx) &&
    !/__aeHarvest\.send\(<port>\)/.test(rx));
});

console.log('\nR-F22: no file tells the operator to call a plain send(8765)');
await block('R-F22', async () => {
  const bare = /__aeHarvest\.send\((8765|<port>|port)\)/;
  const files = [['harvest.js', harvestText], ['dist/harvest.min.js', readFileSync(join(HERE, 'dist', 'harvest.min.js'), 'utf8')],
    ['receiver.mjs', SRC('receiver.mjs')], ['README.md', SRC('../README.md')], ['SKILL.md', skillSrc]];
  for (const [name, text] of files) {
    ok(`R-F22: ${name} never tells the operator to call a plain send()`, !bare.test(text),
      (text.match(new RegExp(bare.source + '[^\\n]*', 'g')) || []).join(' | '));
  }
  ok('R-F22: the README receiver row names {via: \'form\'} after a curl check',
    /\| `scripts\/receiver\.mjs` \| Loopback HTTP receiver: after a `curl` check, `__aeHarvest\.send\(port, \{via: 'form'\}\)`/.test(SRC('../README.md')));
  ok('R-F22: the SKILL.md Files table names {via: \'form\'} after a curl check',
    /\| `scripts\/receiver\.mjs` \| \*\*Primary export\.\*\* Loopback HTTP receiver; after a `curl` check, `__aeHarvest\.send\(port, \{via: 'form'\}\)`/.test(skillSrc));
});

console.log('\nR-F31: the harvest.js usage header and install reply match SKILL.md');
await block('R-F31', async () => {
  const head = harvestText.split('\n').slice(0, 16).join('\n');
  ok('R-F31: the usage header shows send(8765, {via: \'form\'}) after the curl check',
    /await __aeHarvest\.send\(8765, \{via: 'form'\}\)\s+\/\/ payload -> receiver\.mjs, after\s+\*\s+\/\/ curl -s http:\/\/127\.0\.0\.1:8765\/ answers ok/.test(head), head);
  const msg = recheckInstall();
  ok('R-F31: the install reply no longer says "send(8765) to export"', !/send\(8765\) to export/.test(msg), msg);
  ok('R-F31: the install reply carries no em dash', !msg.includes(String.fromCharCode(0x2014)), msg);
});

// ============================================================================
// 2026-10-18, recheck (listing and extract readers): three skeptics each
// confirmed these on the code of the fourth pass. Each block fails on it.
// ============================================================================
const leEl = (tag, p = {}) => ({ tagName: tag, children: p.children || [], textContent: p.text || '', className: p.cls || '',
  naturalWidth: 0, naturalHeight: 0, currentSrc: '', src: '', shadowRoot: null, parentElement: p.parent || null,
  getAttribute: (k) => (p.attrs || {})[k] || null, querySelector: () => null, querySelectorAll: () => p.qsa || [],
  closest: () => null, click() {}, id: '', nodeType: 1, previousElementSibling: p.prev || null,
  childNodes: p.nodes || (p.text ? [{ nodeType: 3, nodeValue: p.text }] : []) });
// listing.js on a stub page; `desc` is the description reply ({ body, images }) or null.
const leListing = async (els, { desc = null, bodyText = 'x'.repeat(2500), ld = 0, title } = {}) => {
  const src = RUN('listing.js');
  const DESC = 'https://pdp.aliexpress-media.com/product/description/pc/v2/en_US/desc.htm?productId=1';
  const win = desc ? {
    performance: { getEntriesByType: () => [{ name: DESC }] },
    fetch: async () => ({ url: DESC, status: 200, ok: true, text: async () => '<html>' + desc.body + '</html>' }),
    DOMParser: class { parseFromString() {
      const p = leEl('P', { text: desc.body });
      const imgs = (desc.images || []).map((u) => leEl('IMG', { attrs: { src: u } }));
      return { body: leEl('BODY', { qsa: [p, ...imgs], nodes: [p] }), querySelectorAll: () => [p, ...imgs] };
    } },
  } : {};
  const document = { title, body: { scrollHeight: 5000, innerText: bodyText }, documentElement: { outerHTML: '' },
    querySelectorAll: (sel) => (/ld\+json/.test(sel || '') ? new Array(ld) : els) };
  return new Function('window', 'document', 'location', `${src}; return window.__aeListing;`)({ scrollTo() {}, document, ...win }, document,
    { href: 'https://he.aliexpress.com/item/1.html' }).read(desc ? {} : { description: false });
};
const leSizes = (r) => [r.productSizeLines, r.packageSizeLines];
// The SKILL.md step-5 reader on a stub page; `want` replaces its WANT list.
const leLd = [{ textContent: JSON.stringify({ '@type': 'Product', aggregateRating: { ratingValue: '4.9', reviewCount: '5479' },
  offers: { price: '3.1', priceCurrency: 'USD' } }) }];
const leStep5 = (els, text, want = null) => {
  const code = want ? step5.replace(/const WANT = \[[^\]]*\];/, 'const WANT = ' + JSON.stringify(want) + ';') : step5;
  const raw = new Function('document', 'location', 'return (' + code + '\n)')(
    { title: 'Mouse', body: { innerText: text }, querySelectorAll: (sel) => (/ld\+json/.test(sel) ? leLd : els) }, { pathname: '/item/1.html' });
  return { raw, out: JSON.parse(raw) };
};
const leOpt = (name, sel) => ({ className: 'sku-item--text--Qa1' + (sel ? ' sku-item--selected--I' : ''), querySelector: () => null,
  textContent: name, shadowRoot: null });
const leSpec = (k, val) => ({ className: 'specification--prop--J', textContent: k + val, shadowRoot: null,
  querySelector: (sel) => (/title/.test(sel) ? { textContent: k } : /desc/.test(sel) ? { textContent: val } : null) });

console.log('\nR-F13: step 5: the 1,000-character cut never drops a selected option first');
await block('R-F13', async () => {
  const WANT10 = ['Type', 'Interface Type', 'Power Type', 'Power Source', 'Battery Included', 'Cable Length', 'Max. DPI',
    'Number of Buttons', 'Operation Mode', 'Material'];
  const specs = WANT10.map((k) => leSpec(k, 'v'.repeat(40)));
  const page = (selAt) => [...Array.from({ length: 12 }, (_, i) => leOpt('Option ' + String(i).padStart(2, '0') + ' ' + 'n'.repeat(14), i === selAt)), ...specs];
  for (const selAt of [11, 3]) {
    const { raw, out } = leStep5(page(selAt), RV.gyro, WANT10);
    ok(`R-F13: selected at ${selAt + 1} of 12: the cut fires and the result fits`, out.optionsCut === true && raw.length <= 1000, String(raw.length));
    ok(`R-F13: selected at ${selAt + 1} of 12: the selected option is kept`, out.options.some((o) => /\*$/.test(o)), JSON.stringify(out.options));
    ok(`R-F13: selected at ${selAt + 1} of 12: only unselected options were cut`, out.options.length < 11 &&
      out.options.filter((o) => /\*$/.test(o)).length === 1, JSON.stringify(out.options));
  }
  // Two selected ones (Color AND Type) past the first 10: both stay.
  const two = [...Array.from({ length: 14 }, (_, i) => leOpt('Option ' + String(i).padStart(2, '0') + ' ' + 'n'.repeat(14), i === 12 || i === 13)), ...specs];
  const t = leStep5(two, RV.gyro, WANT10).out;
  eq('R-F13: two selected options past the first 10 both survive the cut', [t.optionsCut, t.options.filter((o) => /\*$/.test(o)).length], [true, 2]);
  // With the default WANT nothing is cut, as before.
  const d = leStep5(page(11), RV.gyro).out;
  eq('R-F13: the default WANT still cuts nothing', [d.optionsCut, d.options.length], [undefined, 11]);
  ok('R-F13: SKILL.md says unselected options are cut first', /Unselected ones go first\. A selected one is cut\s+only when no unselected one is left\./.test(skillSrc));
});

console.log('\nR-F14: extract.js and harvest.js: a title with a wall phrase does not make a served page a wall');
await block('R-F14', async () => {
  const exSrc = RUN('extract.js');
  const titles = ['Sliding door lock, please slide to lock child safety', 'Cabinet lock for kids', 'Drawer latch strong'];
  const win = { _dida_config_: { _init_data_: { data: { data: { root: { fields: { mods: { itemList: { content: titles.map((t, i) => (
    { productId: 'w' + i, title: { displayTitle: t }, prices: { salePrice: { minPrice: 3, currencyCode: 'USD' } },
      evaluation: { starRating: 4.8 }, trade: { tradeDesc: '1,000+ sold' } })) } } } } } } } } };
  const loc = { href: 'https://www.aliexpress.com/w/wholesale-door-lock.html?page=1', origin: 'https://www.aliexpress.com',
    pathname: '/w/wholesale-door-lock.html', search: '?page=1' };
  const doc = (body) => ({ querySelectorAll: () => [], body: { innerText: body }, documentElement: { outerHTML: '<html>grid</html>' }, title: 'door lock' });
  const run = (w, body) => JSON.parse(new Function('window', 'document', 'location', 'return (' + exSrc + '\n)')(w, doc(body), loc));
  const r = run(win, 'Results ' + titles.join(' US $3.00 ') + ' US $3.00 ' + 'x'.repeat(3000));
  eq('R-F14: a page of 3 items with "please slide" in a title is not blocked', [r.cardCount, r.blocked, r.wall.state], [3, false, 'clear']);
  // What must not change: a real wall still stops.
  eq('R-F14: a wall page with no items is still blocked', run({}, 'Please slide to verify').blocked, true);
  eq('R-F14: the wall\'s own sentence outside the titles still counts', run(win, 'Sorry, we have detected unusual traffic from your network. ' +
    titles.join(' ')).blocked, true);
  ok('R-F14: extract.js uses the same strong-wall sentences as listing.js', (() => {
    const pick = (s) => (s.match(/const STRONG_WALL = (\/.*\/i);/) || [])[1];
    return !!pick(SRC('extract.js')) && pick(SRC('extract.js')) === pick(SRC('listing.js')) && pick(harvestText) === pick(SRC('listing.js'));
  })());
  // harvest.js: the same title in a served page must not stop the run as 'blocked'.
  const items = titles.map((t, i) => makeItem('h' + i, { title: t }));
  const H = loadHarvest(async (url) => { const p = Number(new URL(url).searchParams.get('page'));
    return reply(makePage({ items: p === 1 ? items : [], page: p })); });
  H.start({ query: 'door lock' });
  const st = await H.step(3);
  ok('R-F14: harvest.js keeps going past a title with "please slide"', st.stop !== 'blocked' && JSON.parse(H.payload()).items.length === 3,
    JSON.stringify({ stop: st.stop, wall: st.wall }));
  const W = loadHarvest(async () => reply('<html><body>Sorry, we have detected unusual traffic. Please slide to verify.</body></html>'));
  W.start({ query: 'door lock' });
  eq('R-F14: harvest.js still stops on a wall page', (await W.step(1)).stop, 'blocked');
});

console.log('\nR-F15: listing.js: a product that IS a box keeps its own size; packaging boxes stay cartons');
await block('R-F15', async () => {
  eq('R-F15: "Lunch Box Size: 20 x 15 x 6 cm" in a fetched description is the product size',
    leSizes(await leListing([], { desc: { body: 'Lunch Box Size: 20 x 15 x 6 cm' } })), [['Lunch Box Size: 20 x 15 x 6 cm'], []]);
  eq('R-F15: "Storage box dimensions: 30x20x10cm" is the product size',
    leSizes(await leListing([leEl('P', { text: 'Storage box dimensions: 30x20x10cm' })])), [['Storage box dimensions: 30x20x10cm'], []]);
  eq('R-F15: a bare size under "Lunch box size:" is the product size',
    leSizes(await leListing([leEl('SPAN', { text: '20 x 15 x 6 cm', parent: { textContent: 'Lunch box size: 20 x 15 x 6 cm' } })])), [['20 x 15 x 6 cm'], []]);
  // Packaging phrasing is still the carton.
  for (const t of ['Box size: 30 x 20 x 10 cm', 'Gift box size: 20 x 10 x 5 cm', 'Size (box): 20 x 10 x 5 cm', 'Outer box: 40 x 30 x 20 cm',
    'Size of the box: 20 x 10 x 5 cm', 'Shipping box size: 20 x 10 x 5 cm']) {
    eq(`R-F15: "${t}" is still the carton`, leSizes(await leListing([leEl('P', { text: t })])), [[], [t]]);
  }
  eq('R-F15: a bare size under "Box size:" is still the carton',
    leSizes(await leListing([leEl('SPAN', { text: '20 x 15 x 6 cm', parent: { textContent: 'Box size: 20 x 15 x 6 cm' } })])), [[], ['20 x 15 x 6 cm']]);
  ok('R-F15: SKILL.md says a lunch box size is the product\'s own', /`Lunch Box Size: 20 x 15 x 6 cm` is the product's own\s+size/.test(skillSrc));
});

console.log('\nR-F16: listing.js: one line with the product size and the package size yields both');
await block('R-F16', async () => {
  eq('R-F16: "Size: 10 x 5 x 3 cm Package size: 12 x 7 x 4 cm" splits in two',
    leSizes(await leListing([leEl('P', { text: 'Size: 10 x 5 x 3 cm Package size: 12 x 7 x 4 cm' })])),
    [['Size: 10 x 5 x 3 cm'], ['Package size: 12 x 7 x 4 cm']]);
  eq('R-F16: the same in a fetched description',
    leSizes(await leListing([], { desc: { body: 'Size: 10 x 5 x 3 cm Package size: 12 x 7 x 4 cm' } })),
    [['Size: 10 x 5 x 3 cm'], ['Package size: 12 x 7 x 4 cm']]);
  const span = leEl('SPAN', { text: 'Package size: 12x7x4cm' });
  const p = leEl('P', { text: 'Package size: 12x7x4cm Size: 10x5x3cm', children: [span], nodes: [span, { nodeType: 3, nodeValue: ' Size: 10x5x3cm' }] });
  span.parentElement = p;
  eq('R-F16: <p><span>Package size: …</span> Size: …</p> keeps the product size, the carton once',
    leSizes(await leListing([p, span])), [['Size: 10x5x3cm'], ['Package size: 12x7x4cm']]);
  eq('R-F16: the Hebrew labels split the same way',
    leSizes(await leListing([leEl('P', { text: 'גודל: 10x5x3 ס"מ גודל החבילה: 12x7x4 ס"מ' })])), [['גודל: 10x5x3 ס"מ'], ['גודל החבילה: 12x7x4 ס"מ']]);
  // What must not change: a label after a word is not a second size.
  eq('R-F16: "Lunch Box Size: …" is not split', leSizes(await leListing([leEl('P', { text: 'Lunch Box Size: 20 x 15 x 6 cm' })])),
    [['Lunch Box Size: 20 x 15 x 6 cm'], []]);
  ok('R-F16: SKILL.md says a line with two sizes splits', /A line that\s+holds two sizes splits where the second label starts/.test(skillSrc));
});

console.log('\nR-F17: step 5: soldRaw keeps its first digit when the header has no separator');
await block('R-F17', async () => {
  eq('R-F17: "5479 Reviews 10,000+ sold" gives 10,000+', leStep5([], '4.9 5479 Reviews 10,000+ sold US $1.58').out.soldRaw, '10,000+');
  eq('R-F17: "5479 Reviews 100K+ sold" gives 100K+', leStep5([], '4.9 5479 Reviews 100K+ sold US $1.58').out.soldRaw, '100K+');
  eq('R-F17: "37 Reviews 455 sold" gives 455', leStep5([], '4.8 37 Reviews 455 sold').out.soldRaw, '455');
  // What must not change: the separator mark seen live.
  eq('R-F17: the live separator still works', leStep5([], RV.gyro).out.soldRaw, '50,000+');
  eq('R-F17: "Reviews | 10,000+ sold" works', leStep5([], '4.9 5479 Reviews | 10,000+ sold').out.soldRaw, '10,000+');
});

console.log('\nR-F18: step 5: the text fallback stops where listing.js stops, and reads "Name:"');
await block('R-F18', async () => {
  const listingEnd = (SRC('listing.js').match(/const SPEC_END = (\/.*\/i);/) || [])[1];
  const step5End = ((step5 || '').match(/const END = (\/.*\/i);/) || [])[1];
  ok('R-F18: the step-5 END is listing.js SPEC_END', !!listingEnd && step5End === listingEnd, `${step5End} vs ${listingEnd}`);
  const WANT = ['Type', 'Interface Type', 'Power Type', 'Power Source', 'Battery Included'];
  const pages = {
    youMayAlsoLike: 'x\nSpecifications\nPower Source\nUSB\nYou may also like\nType\nWireless\n' + 'z'.repeat(2500),
    colonNames: 'x\nSpecifications\nPower Source:\nUSB\nType:\nWired\nDescription\nmore\n' + 'z'.repeat(2500),
    hebrewEnd: 'x\nSpecifications\nPower Source\nUSB\nתיאור\nType\nWireless\n' + 'z'.repeat(2500),
  };
  const want = { youMayAlsoLike: { 'Power Source': 'USB' }, colonNames: { 'Power Source': 'USB', Type: 'Wired' }, hebrewEnd: { 'Power Source': 'USB' } };
  for (const k of Object.keys(pages)) {
    const s5 = leStep5([], pages[k]).out;
    eq(`R-F18: ${k}: step 5 reads only this product's rows`, [s5.specFrom, s5.spec], ['text', want[k]]);
    const li = await leListing([], { bodyText: pages[k] });
    const lspec = Object.fromEntries(Object.entries(li.specs).filter(([n]) => WANT.includes(n)));
    eq(`R-F18: ${k}: listing.js gives the same rows`, lspec, want[k]);
  }
  // The DOM path takes "Type:" too.
  eq('R-F18: a DOM title "Type:" is read', leStep5([leSpec('Type:', 'Wired')], RV.gyro).out.spec, { Type: 'Wired' });
});

console.log('\nR-F27: the step-5 docs say the spec class names were measured live on 2026-10-18');
await block('R-F27', async () => {
  ok('R-F27: SKILL.md no longer calls the class names recalled', !/recalled, not yet measured/.test(skillSrc));
  ok('R-F27: SKILL.md says they were measured on a live page on 2026-10-18',
    /were measured on a live page\s+on 2026-10-18 in signed-in Chrome: the `dom` path read the rows/.test(skillSrc));
  ok('R-F27: SKILL.md still says the text layout is not measured', /The `text` line layout is not measured live yet\./.test(skillSrc));
  const lj = SRC('listing.js');
  ok('R-F27: listing.js no longer calls them recalled', !/recalled, NOT yet/.test(lj));
  ok('R-F27: listing.js says they were measured live on 2026-10-18', /\(measured live\s+\*\s+on 2026-10-18 in signed-in Chrome/.test(lj));
});

console.log('\nR-F29: listing.js keeps a real description that starts with "[" (text and images)');
await block('R-F29', async () => {
  const r1 = await leListing([], { desc: { body: '[Size]: 22 x 12 x 28 cm' } });
  eq('R-F29: "[Size]: 22 x 12 x 28 cm" is fetched and its size kept', [r1.description.source, r1.productSizeLines], ['fetched', ['[Size]: 22 x 12 x 28 cm']]);
  ok('R-F29: and raises no description-fetch-failed warning', !r1.warnings.some((w) => /^description-fetch-failed/.test(w)), JSON.stringify(r1.warnings));
  const imgs = Array.from({ length: 6 }, (_, i) => 'https://ae-pic-a1.aliexpress-media.com/kf/S' + i + 'desc' + 'q'.repeat(24) + '.jpg');
  const r2 = await leListing([], { desc: { body: '[Note] Please check the size chart in the pictures before buying.', images: imgs } });
  eq('R-F29: "[Note] ..." with 6 images keeps the text and the images', [r2.description.source, r2.descriptionImages.length], ['fetched', 6]);
  const r3 = await leListing([], { desc: { body: '[Product size] 12 x 6 x 4 cm. Weight: 80 g' } });
  eq('R-F29: "[Product size] 12 x 6 x 4 cm" is fetched', r3.description.source, 'fetched');
  // What must not change: a JSON reply is not a description.
  for (const body of ['{"success":false,"code":"TOKEN_EXPIRED"}', '[{"code":"x"}]', '{"code":"TOKEN_EXPI']) {
    eq(`R-F29: the JSON reply ${body} is still fetch-failed`, (await leListing([], { desc: { body } })).description.source, 'fetch-failed');
  }
  eq('R-F29: an empty reply is still fetch-failed', (await leListing([], { desc: { body: '' } })).description.source, 'fetch-failed');
});

console.log('\nR-F04: decode.mjs: an old part with an unknown extra joins no other stream, at any merge depth');
await block('R-F04', async () => {
  const { mergePayloads } = await import('./decode.mjs');
  const P = (q, ids, pages, verdict, extra = {}) => ({ query: q, source: 'harvest-paged', coverage: { verdict }, fourStar: true,
    pages: pages.map(([page, n]) => ({ page, n })), items: ids.map((id) => ({ id, title: q + ' ' + id, rating: 4.8, sold: 500 })), ...extra });
  // The finding's scenario: OLD payloads (extraApplied: true, no filterKey), as every September harvest.js wrote them.
  const o1 = P('usb mouse', ['m1'], [[1, 1], [2, 0]], 'exhausted-all-results');
  const o2 = P('wire brush set', ['a1', 'a2', 'a3'], [[1, 1], [2, 1], [3, 1]], 'truncated', { extraApplied: true });
  const o3 = P('wire brush set', ['b4'], [[4, 0]], 'exhausted-from-start-page', { extraApplied: true });
  const o4 = P('wire brush set', ['c5'], [[5, 0]], 'exhausted-from-start-page', { extraApplied: true });
  const view = (m) => m.coverage.byQuery.map((s) => [s.stream, s.pagesRead.join(','), s.verdict]);
  const disk = (m) => JSON.parse(JSON.stringify(m)); // a merged file as it is saved and read back
  const one = mergePayloads([o1, o2, o3]);
  const m12 = disk(mergePayloads([o1, o2]));
  const again = mergePayloads([m12, o3]);
  eq('R-F04: one merge of the three old payloads is truncated', one.coverage.verdict, 'truncated');
  eq('R-F04: a merged file merged again with the third is truncated, not exhausted-all-results', again.coverage.verdict, 'truncated');
  eq('R-F04: and it has the same streams, pages and verdicts as one merge', view(again), view(one));
  const deep = mergePayloads([disk(again), o4]);
  eq('R-F04: three levels deep, still the same streams as one merge of all four', view(deep), view(mergePayloads([o1, o2, o3, o4])));
  ok('R-F04: no part key is a position in the call (unknown-extra-<n>)', ![...one.parts, ...deep.parts].some((x) => /^unknown-extra-\d+$/.test(x.filterKey)),
    JSON.stringify(deep.parts.map((x) => x.filterKey)));
  const keyOfO2 = (m) => m.parts.find((x) => x.cardCount === 3).filterKey;
  eq('R-F04: an old part has one key wherever it sits in the call', keyOfO2(mergePayloads([o2, o1])), keyOfO2(mergePayloads([o1, o2])));
  // A merged file written by the decode.mjs before this fix keyed old parts by position.
  const legacy = (m) => ({ ...m, parts: m.parts.map((x) => (/^unknown-extra-/.test(x.filterKey) ? { ...x, filterKey: 'unknown-extra-0' } : x)) });
  const L1 = legacy(disk(mergePayloads([o2, o1])));
  const L2 = legacy(disk(mergePayloads([o3, P('usb mouse', ['m2'], [[1, 1], [2, 0]], 'exhausted-all-results')])));
  eq('R-F04: two old-format merged files that both say "unknown-extra-0" do not join', mergePayloads([L1, L2]).coverage.verdict, 'truncated');
  // The documented path: the decode.mjs CLI on saved files.
  const dir = tmp('ae-f04-');
  [o1, o2, o3].forEach((p, i) => fsx.writeFileSync(join(dir, 'o' + (i + 1) + '.json'), JSON.stringify(p)));
  const DECODE = join(HERE, 'decode.mjs');
  const merged = execFileSync('node', [DECODE, join(dir, 'o1.json'), join(dir, 'o2.json')], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  fsx.writeFileSync(join(dir, 'm12.json'), merged);
  const check = JSON.parse(execFileSync('node', [DECODE, '--check', join(dir, 'm12.json'), join(dir, 'o3.json')], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
  eq('R-F04: decode.mjs --check on a merged file plus the third file says truncated', check.coverage.verdict, 'truncated');
  // What must not change.
  eq('R-F04: re-adding a part the merged file already holds changes no stream', view(mergePayloads([m12, o2])), view(m12));
  eq('R-F04: the merged file second in the call gives the same streams', view(mergePayloads([o3, m12])).sort(), view(one).sort());
  eq('R-F04: two different old payloads in one call are still two streams', mergePayloads([o2, o3]).coverage.byQuery.length, 2);
  ok('R-F04: SKILL.md says such a part joins no other part, in a re-merge too',
    /Its key comes from its content, so it joins no\s+other part, in a merge or in a merge of merged files/.test(skillSrc));
});

console.log('\nR-F08: receiver.mjs: a flag with no value or a stray word exits 2, and nothing starts');
await block('R-F08', async () => {
  const { spawn } = await import('node:child_process');
  const run = (args, cwd) => new Promise((res) => {
    const cp = spawn('node', [join(HERE, 'receiver.mjs'), ...args], { cwd });
    let out = '';
    let err = '';
    cp.stdout.on('data', (d) => { out += d; });
    cp.stderr.on('data', (d) => { err += d; });
    // The old code waited for --idle (or 3600 s): stop it, it counts as a failure.
    const t = setTimeout(() => cp.kill(), 4000);
    cp.on('exit', (code) => { clearTimeout(t); res({ code, out, err, say: `exit ${code} ${err.trim()} ${out.trim()}` }); });
  });
  const cwd = tmp('ae-rx-f08-');
  const port = async () => String(await freePort());
  // `--dir $OUT --port N` with OUT unset: the shell drops the empty word.
  const r1 = await run(['--dir', '--port', await port(), '--idle', '1'], cwd);
  ok('R-F08: --dir followed by --port exits 2 and names the missing value', r1.code === 2 && /--dir needs a value/.test(r1.err), r1.say);
  ok('R-F08: and no directory named "--port" is made', !fsx.existsSync(join(cwd, '--port')));
  const r2 = await run([join(cwd, 'r_pos'), '--port', await port(), '--idle', '1'], cwd);
  ok('R-F08: a stray positional directory exits 2 and is named', r2.code === 2 && /stray argument/.test(r2.err) && r2.err.includes('r_pos'), r2.say);
  ok('R-F08: and the receiver never listened in the cwd', !/listening/.test(r2.out), r2.say);
  const r3 = await run(['--dir', '', '--port', await port(), '--idle', '1'], cwd);
  ok('R-F08: an empty --dir (a quoted unset variable) exits 2', r3.code === 2 && /--dir is empty/.test(r3.err), r3.say);
  const r4 = await run(['--dir=', '--port', await port(), '--idle', '1'], cwd);
  ok('R-F08: --dir= with nothing after it exits 2', r4.code === 2 && /--dir is empty/.test(r4.err), r4.say);
  const r5 = await run(['--dir', join(cwd, 'd5'), '--port', await port(), '--idle'], cwd);
  ok('R-F08: a last flag with no value exits 2 (it used to take the default)', r5.code === 2 && /--idle needs a value/.test(r5.err), r5.say);
  // What must not change.
  const r6 = await run(['--dir=' + join(cwd, 'd6'), '--port=' + await port(), '--idle=1'], cwd);
  ok('R-F08: --name=value still starts and exits 0 after --idle', r6.code === 0 && /listening http:\/\/127\.0\.0\.1:\d+ dir .*d6 /.test(r6.out), r6.say);
  const r7 = await run(['--dir', join(cwd, 'd7'), '--port', await port(), '--idle', '1'], cwd);
  ok('R-F08: --name value still starts and exits 0 after --idle', r7.code === 0 && /dir .*d7 /.test(r7.out) && fsx.existsSync(join(cwd, 'd7')), r7.say);
  const r8 = await run(['--dir', join(cwd, 'd8'), '--idel', '5'], cwd);
  ok('R-F08: an unknown flag still exits 2 and is named', r8.code === 2 && /unknown flag --idel/.test(r8.err), r8.say);
  ok('R-F08: SKILL.md says a flag with no value or a stray word exits 2',
    /A flag with no value,\s+an empty `--dir`, an unknown flag or a stray word exits 2/.test(skillSrc));
  // Last: the old receiver.mjs has no parseArgs, so these throw there.
  const { parseArgs } = await import('./receiver.mjs');
  eq('R-F08: parseArgs reads both flag forms', parseArgs(['--dir', '/a', '--port=1']), { opts: { dir: '/a', port: '1' }, error: null });
  eq('R-F08: a value that starts with "--" is taken only after "="', [parseArgs(['--dir=--x']).opts.dir, /needs a value/.test(parseArgs(['--dir', '--x']).error)], ['--x', true]);
  eq('R-F08: the first of a repeated flag counts, as before', parseArgs(['--port', '1', '--port', '2']).opts.port, '1');
});

// ============================================================================
// 2026-10-19, recheck (docs): three skeptics each confirmed these on the code
// and the docs of 2026-10-18. Each block fails on that copy.
// ============================================================================
/* A harvest of 4 items in a fake tab whose loopback fetch is refused, as
 * both browsers refused it on 2026-10-18. `lb.n` counts loopback fetches,
 * `forms` the forms posted (each one is a navigation). */
const docsTab = async ({ hidden = false, storage = true } = {}) => {
  const forms = [];
  const lb = { n: 0 };
  const win = { document: formDoc(forms, { doc: { visibilityState: hidden ? 'hidden' : 'visible' } }) };
  if (storage) win.localStorage = fakeStorage();
  const H = await harvestWith(win, async (url) => {
    if (url.startsWith('http://127.0.0.1:')) { lb.n++; throw new TypeError('Failed to fetch'); }
    return reply(makePage({ items: [makeItem('d1'), makeItem('d2'), makeItem('d3'), makeItem('d4')] }));
  });
  return { H, forms, lb };
};
/* What a submitted text/plain form sends: "<name>=<value>". */
const formBody = (f) => (f.children || []).map((c) => c.name + '=' + c.value).join('\r\n') + '\r\n';

console.log('\nR-F01: the replies under send(8765, {via: \'form\'}) are the form-path replies');
await block('R-F01', async () => {
  const fence = (skillSrc.match(/```js\nawait __aeHarvest\.send\(8765, \{via: 'form'\}\)[^\n]*\n([\s\S]*?)```/) || [])[1] || '';
  ok('R-F01: SKILL.md lists replies under the via:form call', fence.length > 0);
  ok('R-F01: the list shows no fetch-path reply (DELIVERED: sent, FETCH-ERROR, did NOT navigate, fetch held)',
    fence.length > 0 && !/DELIVERED: sent|FETCH-ERROR|did NOT navigate|fetch held/.test(fence), fence);
  // The real replies of send(port, {via: 'form'}), visible and hidden.
  const v = await docsTab();
  const mv = await v.H.send(8765, { via: 'form' });
  ok('R-F01: real code, visible tab: UNCONFIRMED: form-posted ...; backup saved (n items)',
    /^UNCONFIRMED: form-posted \d+ chars to http:\/\/127\.0\.0\.1:8765\/harvest; backup saved \(4 items\) - delivered only if the receiver prints "saved <path>" in its own output: read it there/.test(mv), mv);
  ok('R-F01: the documented visible-tab reply has that shape',
    /visible tab: "UNCONFIRMED: form-posted \d+ chars to http:\/\/127\.0\.0\.1:8765\/harvest; backup saved \(\d+ items\)\s*\n\/\/\s+- delivered only if the receiver prints "saved <path>" in its own output: read it there/.test(fence), fence);
  const h = await docsTab({ hidden: true });
  const mh = await h.H.send(8765, { via: 'form' });
  ok('R-F01: real code, hidden tab: (tab hidden: fetch skipped); backup saved', /^UNCONFIRMED: form-posted \d+ chars to \S+ \(tab hidden: fetch skipped\); backup saved \(4 items\)/.test(mh), mh);
  ok('R-F01: the documented hidden-tab reply has that shape', /hidden tab:\s+"UNCONFIRMED: form-posted … \(tab hidden: fetch skipped\); backup saved \(\d+ items\)/.test(fence), fence);
  const n = await docsTab({ storage: false });
  const mn = await n.H.send(8765, { via: 'form' });
  ok('R-F01: real code, no backup: NOT DELIVERED: no form posted', /^NOT DELIVERED: no form posted, because the localStorage backup failed/.test(mn) && n.forms.length === 0, mn);
  ok('R-F01: the documented no-backup reply has that shape', /no backup:\s+"NOT DELIVERED: no form posted, because the localStorage backup failed/.test(fence), fence);
  // The receiver's own output is where "saved <path>" shows: post the real form body to a real receiver.
  const dir = tmp('ae-f01-');
  const logs = [];
  const rx = await startRx({ dir, port: 0, log: (m) => logs.push(m) });
  try {
    const res = await fetch('http://127.0.0.1:' + rx.port + '/harvest', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: formBody(v.forms[0]) });
    eq('R-F01: the posted form body is saved by the receiver', res.status, 200);
  } finally { await rx.close(); }
  ok('R-F01: the receiver prints "saved <dir>/harvest-<query>-<stamp>.json"', logs.some((l) => /^saved .*\/harvest-wire-brush-set-[^/]+\.json$/.test(l)), JSON.stringify(logs));
  ok('R-F01: the list shows that receiver line', /"saved <dir>\/harvest-<query>-<stamp>\.json"/.test(fence), fence);
  ok('R-F01: SKILL.md gives the fetch-path replies only for a plain send(8765)',
    /\*\*A plain `send\(8765\)`\*\* \(no `via`\) tries a `fetch\(\)` POST first/.test(skillSrc));
  const rxText = SRC('receiver.mjs');
  ok('R-F01: the receiver.mjs header says the receiver prints saved <path>, not that the tool result names the file',
    /the receiver prints `saved <path>` in its own output/.test(rxText) && !/so the tool result names the file/.test(rxText));
});

console.log('\nR-F05: the hidden-tab recovery says a via:\'form\' send to a dead port navigates in a visible tab too');
await block('R-F05', async () => {
  const at = skillSrc.indexOf('### A hidden tab');
  const rec = skillSrc.slice(at, skillSrc.indexOf('What to do:', at));
  ok('R-F05: SKILL.md no longer says a visible-tab send() to a dead port does not navigate',
    !/In a visible tab a `send\(\)` to a dead port returns `NOT DELIVERED`\s+and does not navigate/.test(skillSrc));
  ok('R-F05: step 1 says the check is needed in a visible tab as well', /Do not skip this check in a hidden\s+tab, or in a visible one\./.test(rec), rec.slice(0, 200));
  ok('R-F05: step 1 says via:form always posts the form, visible or hidden',
    /`send\(<port>, \{via: 'form'\}\)` never tries a\s+fetch\. It always posts the form/.test(rec) && /navigates to an error page, visible or\s+hidden/.test(rec));
  ok('R-F05: step 1 names the curl check as the only dead-port guard', /The curl check is the only guard against a dead port\./.test(rec));
  // What the doc must match, on the real code: a visible tab, a dead port.
  const p = await docsTab();
  const plain = await p.H.send(8765);
  ok('R-F05: real code: a plain send() to a dead port stays on the page', /^NOT DELIVERED: FETCH-ERROR/.test(plain) && p.forms.length === 0, plain);
  const before = p.lb.n;
  const viaForm = await p.H.send(8765, { via: 'form' });
  ok('R-F05: real code: send(port, {via: \'form\'}) to a dead port in a VISIBLE tab posts the form (navigates)',
    /^UNCONFIRMED: form-posted/.test(viaForm) && p.forms.length === 1, viaForm);
  eq('R-F05: real code: and it never tried the fetch', p.lb.n, before);
  ok('R-F05: the harvest.js send() comment says via:form navigates even to a dead port',
    /It always posts the form, so it navigates even to a dead port,\s+\*\s+visible tab or hidden/.test(harvestText));
});

console.log('\nR-F06: restore() of a stopped harvest says resume() comes first, and SKILL.md step 4 says it');
await block('R-F06', async () => {
  const ls = fakeStorage();
  const fetched = [];
  let wallOn = true;
  const f = async (url) => {
    const p = Number(new URL(url).searchParams.get('page'));
    fetched.push(p);
    if (p === 3 && wallOn) return reply('<html>Please slide to verify</html>', 'https://he.aliexpress.com/w/x.html/_____tmd_____/punish?x5secdata=abc');
    return reply(makePage({ items: p <= 4 ? [makeItem('w' + p + 'a'), makeItem('w' + p + 'b')] : [], page: p }));
  };
  const w1 = { localStorage: ls };
  new Function('window', 'fetch', harvestSrc)(w1, f);
  w1.__aeHarvest.start({ query: 'wire brush set' });
  const s1 = await w1.__aeHarvest.step(6);
  eq('R-F06: the first tab stops at the wall on page 3', [s1.stop, s1.pagesRead], ['blocked', 2]);
  const w2 = { localStorage: ls };
  new Function('window', 'fetch', harvestSrc)(w2, f);
  const r = w2.__aeHarvest.restore();
  eq('R-F06: restore() brings the stop back with the items', [r.restored, r.stop, r.unique], [true, 'blocked', 4]);
  ok('R-F06: its note says step() reads nothing until resume(), and that it is a wall',
    /step\(\) reads nothing until resume\(\)/.test(r.note || '') && /wall/.test(r.note || ''), JSON.stringify(r.note));
  ok('R-F06: the restore() reply fits the Chrome cap and has no "?"', JSON.stringify(r).length < 1000 && !JSON.stringify(r).includes('?'), String(JSON.stringify(r).length));
  fetched.length = 0;
  const s2 = await w2.__aeHarvest.step(6);
  eq('R-F06: step() right after restore() reads nothing (what step 4 hid)', [fetched.length, s2.stop, s2.pagesRead], [0, 'blocked', 2]);
  wallOn = false;
  w2.__aeHarvest.resume();
  const s3 = await w2.__aeHarvest.step(6);
  eq('R-F06: after resume(), step() reads on from page 3 to the empty page', [fetched, s3.stop, s3.pagesRead], [[3, 4, 5], 'exhausted', 5]);
  // The other stops: the note names the call that lifts each one.
  const restoredNote = async (startOpts, n, pages) => {
    const l2 = fakeStorage();
    const g = async (url) => { const p = Number(new URL(url).searchParams.get('page')); return reply(makePage({ items: (pages[p] || []).map((id) => makeItem(id)), page: p })); };
    const a = { localStorage: l2 };
    new Function('window', 'fetch', harvestSrc)(a, g);
    a.__aeHarvest.start(Object.assign({ query: 'wire brush set' }, startOpts));
    await a.__aeHarvest.step(n);
    const b = { localStorage: l2 };
    new Function('window', 'fetch', harvestSrc)(b, g);
    return b.__aeHarvest.restore();
  };
  const pages = { 1: ['n1'], 2: ['n2'], 3: ['n3'] };
  const rb = await restoredNote({ maxRequests: 1 }, 6, pages);
  ok('R-F06: a request-budget stop: the note names resume({ maxRequests })', rb.stop === 'request-budget' && /resume\(\{ maxRequests \}\)/.test(rb.note || ''), JSON.stringify([rb.stop, rb.note]));
  const rc = await restoredNote({ maxPages: 1 }, 6, pages);
  ok('R-F06: a page-cap stop below page 60: the note names resume({ maxPages })', rc.stop === 'page-cap' && /resume\(\{ maxPages \}\)/.test(rc.note || ''), JSON.stringify([rc.stop, rc.note]));
  const re = await restoredNote({}, 6, pages);
  ok('R-F06: an exhausted stop: the note says nothing is left to read', re.stop === 'exhausted' && /nothing is left to read/.test(re.note || ''), JSON.stringify([re.stop, re.note]));
  const rn = await restoredNote({}, 1, pages);
  eq('R-F06: no stop, no note (what must not change)', [rn.stop, 'note' in rn], [null, false]);
  ok('R-F06: SKILL.md step 4 says to call resume() before step() when the reply shows a stop',
    /\*\*If the reply\s+shows a `stop`, call `__aeHarvest\.resume\(\)` before `step\(\)`\.\*\*/.test(skillSrc));
  ok('R-F06: and that a wall stop goes to Step 2 first', /`suspect-wall` stop is a wall: go to Step 2 \(the wall\) before you\s+resume\./.test(skillSrc));
});

console.log('\nR-F19: no SKILL.md text tells the operator to doubt a specFrom: \'dom\' row');
await block('R-F19', async () => {
  ok('R-F19: SKILL.md never calls the spec class names recalled or not measured',
    !/recalled/i.test(skillSrc) && !/class names[^.]{0,60}not (yet )?measured/i.test(skillSrc));
  ok('R-F19: the spec bullet names the three measured classes and says to trust a dom row',
    /\(`specification--prop`, `--title`, `--desc`\) were measured on a live page/.test(skillSrc) && /Trust a\s+`dom` row\./.test(skillSrc));
  ok('R-F19: the step-5 reader reads exactly those three classes',
    /specification--prop/.test(step5) && /\[class\*="specification--title"\]/.test(step5) && /\[class\*="specification--desc"\]/.test(step5));
});

console.log('\nR-F30: the listing.js readSpecs comment says the class names were measured live');
await block('R-F30', async () => {
  const lj = SRC('listing.js');
  const doc = (lj.match(/\/\* The Specifications table\.[\s\S]*?\*\//) || [''])[0];
  ok('R-F30: the readSpecs comment is there', doc.length > 0);
  ok('R-F30: it no longer says the class names are recalled', doc.length > 0 && !/recalled/i.test(doc), doc);
  ok('R-F30: it says the dom classes were measured live on 2026-10-18',
    /specification--desc inside specification--prop \(measured live\s+\*\s+on 2026-10-18 in signed-in Chrome/.test(doc), doc);
  const fn = (lj.match(/function readSpecs\(\) \{[\s\S]*?\n  \}/) || [''])[0];
  ok('R-F30: readSpecs() reads those classes', /specification--prop/.test(fn) && /specification--title/.test(fn) && /specification--desc/.test(fn));
});

console.log('\nR-F23: extract.js and the refine-filter snippet can be read under the 1,000-character cut');
await block('R-F23', async () => {
  // The step-1 refine-filter snippet, run from SKILL.md on a big filter list.
  const refine = (skillSrc.match(/<!-- @snippet:refine:start -->\s*```js\n([\s\S]*?)\n```\s*<!-- @snippet:refine:end -->/) || [])[1];
  ok('R-F23: SKILL.md carries the refine-filter snippet between its markers', !!refine);
  if (refine) {
    const groups = Array.from({ length: 30 }, (_, g) => ({ title: 'Attribute group number ' + g, paramName: 'attr', attributeId: 1000 + g,
      content: Array.from({ length: 40 }, (_, o) => ({ text: 'Option value ' + o + ' of group ' + g, selectedValue: (1000 + g) + '-' + (5000 + o) })) }));
    const rw = { _dida_config_: { _init_data_: { data: { data: { root: { fields: { mods: { searchRefineFilters: { content: groups } } } } } } } } };
    const line = new Function('window', 'return (' + refine + '\n)')(rw);
    ok('R-F23: the refine snippet result fits the Chrome cap and has no "?"', typeof line === 'string' && line.length < 1000 && !line.includes('?'), String(line && line.length));
    ok('R-F23: it says when it cut the group list', /cut: 30 groups$/.test(line), line.slice(-60));
    ok('R-F23: the whole list stays on window.__aeRefine', Array.isArray(rw.__aeRefine) && rw.__aeRefine.length === 30 && rw.__aeRefine.every((x) => x.opts.length === 40));
    const piece = JSON.stringify(rw.__aeRefine[3].opts.slice(0, 15));
    ok('R-F23: the documented one-group piece fits the cap', /`JSON\.stringify\(__aeRefine\[3\]\.opts\.slice\(0, 15\)\)`/.test(skillSrc) && piece.length < 1000, String(piece.length));
    const few = { _dida_config_: { _init_data_: { data: { data: { root: { fields: { mods: { searchRefineFilters: { content: groups.slice(0, 3) } } } } } } } } };
    eq('R-F23: a short list comes back whole, one line per group', new Function('window', 'return (' + refine + '\n)')(few),
      '0 Attribute group number 0 attr (40) | 1 Attribute group number 1 attr (40) | 2 Attribute group number 2 attr (40)');
  }
  const fb = skillSrc.slice(skillSrc.indexOf('### Single-page fallback'), skillSrc.indexOf('### Getting a large payload'));
  ok('R-F23: SKILL.md says Chrome cuts the return value and names __aeExtract',
    /\*\*The Chrome\s+connector cuts it at 1,000 characters\*\*, so the result also stays on\s+`window\.__aeExtract`/.test(fb));
  const exSrc = RUN('extract.js');
  const items = Array.from({ length: 60 }, (_, i) => makeItem('1005009' + String(i).padStart(6, '0'),
    { title: 'Wired USB Mouse Optical Ergonomic Office Gaming Mouse 1600 DPI model ' + i, soldRaw: '1,000+' }));
  const forms = [];
  const win = { _dida_config_: { _init_data_: { data: { data: { root: { fields: { mods: { itemList: { content: items } } } } } } } } };
  const doc = Object.assign(formDoc(forms), { querySelectorAll: () => [], title: 't', documentElement: { outerHTML: '<html>grid</html>' } });
  doc.body = { innerText: 'grid page', appendChild() {} };
  const loc = { href: 'https://he.aliexpress.com/w/wholesale-wired-usb-mouse.html?page=1', origin: 'https://he.aliexpress.com',
    pathname: '/w/wholesale-wired-usb-mouse.html', search: '?page=1' };
  const raw = new Function('window', 'document', 'location', 'return (' + exSrc + '\n)')(win, doc, loc);
  ok('R-F23: the return value of 60 items is far over the cut (the finding)', raw.length > 10000, String(raw.length));
  const X = win.__aeExtract;
  ok('R-F23: the whole result stays on window.__aeExtract', !!X && !!X.result && X.result.items.length === 60, X ? '' : 'no __aeExtract');
  if (!X || !X.result) return;
  eq('R-F23: and it is the result the return value holds', JSON.stringify(X.result), raw);
  const js = (fb.match(/```js\n([\s\S]*?)```/) || [])[1] || '';
  const calls = js.split(/\n(?=\S)/).map((c) => c.trim().replace(/\s*\/\/[^\n]*$/, '').trim()).filter(Boolean);
  ok('R-F23: SKILL.md gives the Chrome pieces: a summary, two items, and send()', calls.length === 3 && /^__aeExtract\.send\(8765\)$/.test(calls[2]), JSON.stringify(calls));
  for (const c of calls.slice(0, 2)) {
    const out = new Function('__aeExtract', 'return (' + c + ')')(X);
    const s = typeof out === 'string' ? out : JSON.stringify(out);
    ok(`R-F23: "${c.slice(0, 40)}…" fits the Chrome cap and has no "?"`, s.length < 1000 && !s.includes('?'), String(s.length));
  }
  // send(): one form to the receiver; the receiver saves it; rank.mjs takes the saved file.
  const port = await freePort();
  const msg = X.send(port);
  ok('R-F23: __aeExtract.send(port) posts one text/plain form to the receiver',
    forms.length === 1 && forms[0].method === 'POST' && forms[0].enctype === 'text/plain' && forms[0].action === 'http://127.0.0.1:' + port + '/harvest');
  ok('R-F23: its reply is UNCONFIRMED, fits the cap and has no "?"', /^UNCONFIRMED: form-posted \d+ chars \(60 items\)/.test(msg) && msg.length < 1000 && !msg.includes('?'), msg);
  const dir = tmp('ae-f23-');
  const logs = [];
  const rx = await startRx({ dir, port, log: (m) => logs.push(m) });
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/harvest', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: formBody(forms[0]) });
    eq('R-F23: the receiver saves the posted extract result', res.status, 200);
  } finally { await rx.close(); }
  const savedPath = ((logs.find((l) => /^saved /.test(l)) || '').match(/^saved (.+)$/) || [])[1];
  ok('R-F23: the receiver prints saved <path>', !!savedPath, JSON.stringify(logs));
  if (savedPath) {
    const saved = JSON.parse(fsx.readFileSync(savedPath, 'utf8'));
    eq('R-F23: the saved file holds all 60 items', saved.items.length, 60);
    const rk = rank(saved, ['--mode', 'shortlist', '--top', '5']);
    eq('R-F23: rank.mjs takes the saved file as it is', rk.ranked.length, 5);
  }
});

console.log('\nR-F26: the ownRating example matches the review block it cites');
await block('R-F26', async () => {
  ok('R-F26: SKILL.md no longer claims a measured "own 4.1 from 1,090 ratings"', !/own 4\.1 from 1,090/.test(skillSrc));
  const bullet = (skillSrc.match(/- \*\*`ownRating` is the listing's own rating\*\*[\s\S]*?(?=\n- \*\*)/) || [''])[0];
  const blk = parseReviewBlock(RV.gyro);
  ok('R-F26: the bullet cites "4.9 1090 ratings", and the shared parser reads 4.9 from 1,090 there',
    /"4\.9 1090 ratings"/.test(bullet) && blk.ownRating === 4.9 && blk.own === 1090, bullet);
  ok('R-F26: the bullet calls the 4.1 pair a made-up test case', /made-up one\s+\(pooled 4\.9, own 4\.1\)/.test(bullet), bullet);
  const rk = SRC('rank.mjs');
  ok('R-F26: rank.mjs no longer presents 4.1 from 1,090 as a measured listing',
    !/a listing rated 4\.1 by its own 1,090\s+\* buyers was ranked/.test(rk) && /that pair is a test\s+\* case, not a measured page/.test(rk));
});

console.log('\nR-F28: every command in a SKILL.md bash block runs the skill scripts by their absolute path');
await block('R-F28', async () => {
  const lines = [...skillSrc.matchAll(/```bash\n([\s\S]*?)```/g)].flatMap((m) => m[1].split('\n'));
  const rel = lines.filter((l) => /(labels\.sh|\.mjs)\b/.test(l) &&
    !/~\/\.claude\/skills\/aliexpress-finder\/scripts\/(labels\.sh|[a-z]+\.mjs)\b/.test(l));
  eq('R-F28: no bash line runs a skill script by a relative path', rel, []);
  ok('R-F28: labels.sh fetch and crop use the absolute path',
    /^~\/\.claude\/skills\/aliexpress-finder\/scripts\/labels\.sh fetch /m.test(skillSrc) &&
    /^~\/\.claude\/skills\/aliexpress-finder\/scripts\/labels\.sh crop /m.test(skillSrc));
  ok('R-F28: no SKILL.md line starts with the relative scripts/labels.sh', !/^scripts\/labels\.sh /m.test(skillSrc));
  ok('R-F28: the path names the labels.sh beside this test', fsx.existsSync(join(HERE, 'labels.sh')));
});

console.log('\nR-F21: step 3, the Files table and the README say send(8765, {via: \'form\'}) navigates, to a dead port too');
await block('R-F21', async () => {
  const s3 = skillSrc.slice(skillSrc.indexOf('### Getting a large payload out of the browser'), skillSrc.indexOf('**Fallbacks**'));
  ok('R-F21: step 3 no longer calls the export it recommends safe from navigation', !/It is safe \(the page does not\s+navigate\)/.test(s3));
  ok('R-F21: step 3 says {via: \'form\'} never tries the fetch', /`\{via: 'form'\}` never tries the fetch\./.test(s3));
  ok('R-F21: step 3 says a form POST always navigates, to a dead port too', /\*\*A\s+form\s+POST always navigates, to a dead port too\.\*\*/.test(s3));
  ok('R-F21: step 3 names the curl check as the guard and restore() as the way back',
    /the\s+curl check before `send\(\)` is the guard against a dead port, and\s+`restore\(\)` is the way back/.test(s3));
  ok('R-F21: the Files table says send(port, {via: \'form\'}) navigates even to a dead port',
    /`send\(port, \{via: 'form'\}\)` always posts the form, so it navigates even to a dead port: curl the receiver first/.test(skillSrc));
  ok('R-F21: the README says it too',
    /`send\(port, \{via: 'form'\}\)`, the export to use, always posts the form, so it navigates even to a dead port/.test(SRC('../README.md')));
  // Every "does not / never navigates" claim names which send() it is about.
  for (const [name, text] of [['SKILL.md', skillSrc], ['README.md', SRC('../README.md')]]) {
    const bad = text.split(/\n\s*\n/).filter((p) => /(does not|did NOT|never) navigates?\b/i.test(p) && !/plain `send\(|\{via: 'form'\}|FETCH-ERROR/.test(p));
    eq(`R-F21: every no-navigation claim in ${name} names the send() it is about`, bad.map((p) => p.slice(0, 80)), []);
  }
  // The code the doc describes: the same visible tab, the same dead port, both calls.
  const t = await docsTab();
  const a = await t.H.send(8765);
  const b = await t.H.send(8765, { via: 'form' });
  eq('R-F21: real code: plain send() stays, {via: \'form\'} navigates', [/^NOT DELIVERED/.test(a), /^UNCONFIRMED: form-posted/.test(b), t.forms.length], [true, true, 1]);
});

/* The documented safety and score constants (recheck, 2026-10-19). Each one
 * could change in the code, or in the docs, with the suite green: a request
 * budget of 40 went past nothing. The budget of 24 keeps one harvest and
 * its detail pages under the wall, which tripped near 50-60 requests. A
 * deliberate change edits this pin, the code and the docs together. */
console.log('\nR-F24: the request budget, the page cap and the flag thresholds are pinned');
await block('R-F24', async () => {
  const PIN = { maxPages: 20, maxRequests: 24, fewShare: 0.02, fewMinSold: 1000, soldSaturated: 10000, brandImplausible: 0.2 };
  const endless = async (url) => {
    const p = Number(new URL(url).searchParams.get('page'));
    return reply(makePage({ items: [makeItem('pin' + p)], page: p }));
  };
  // harvest.js: the plan reports the defaults, and the run uses them.
  const H = loadHarvest(endless);
  const plan = H.start({ query: 'wire brush set' });
  eq('R-F24: start() defaults are maxPages 20 and maxRequests 24', [plan.maxPages, plan.maxRequests], [PIN.maxPages, PIN.maxRequests]);
  const s1 = await H.step(100);
  eq('R-F24: with no options a run reads pages 1-20 and stops as page-cap', [s1.stop, s1.pagesRead, s1.requests], ['page-cap', PIN.maxPages, PIN.maxPages]);
  const Hb = loadHarvest(endless);
  Hb.start({ query: 'wire brush set', maxPages: 60 });
  const s2 = await Hb.step(100);
  eq('R-F24: the default budget stops a run after 24 requests', [s2.stop, s2.requests, s2.pagesRead], ['request-budget', PIN.maxRequests, PIN.maxRequests]);
  const Hc = loadHarvest(endless);
  Hc.start({ query: 'wire brush set', maxRequests: 60 });
  const s3 = await Hc.step(100);
  eq('R-F24: the default page cap stops a run at page 20', [s3.stop, s3.pagesRead], ['page-cap', PIN.maxPages]);
  // The docs state the same numbers.
  const numIn = (re, text) => { const m = text.match(re); return m ? Number(m[1].replace(/,/g, '')) : null; };
  const readme = SRC('../README.md');
  eq('R-F24: SKILL.md states the harvest defaults', [numIn(/Defaults are `maxPages: (\d+)`/, skillSrc),
    numIn(/`maxRequests: (\d+)`,\s+`startPage: 1`/, skillSrc)], [PIN.maxPages, PIN.maxRequests]);
  eq('R-F24: SKILL.md step 4 counts the recovery budget from 24', numIn(/maxRequests: <(\d+) minus the requests spent>/, skillSrc), PIN.maxRequests);
  eq('R-F24: the harvest.js usage header states the defaults', [numIn(/maxPages\s+default (\d+)/, harvestText),
    numIn(/maxRequests default (\d+)/, harvestText)], [PIN.maxPages, PIN.maxRequests]);
  eq('R-F24: README.md states the budget default', numIn(/\(`maxRequests`, default (\d+)\)/, readme), PIN.maxRequests);
  // rank.mjs: each flag fires on one side of its threshold and not on the other.
  const flagsOf = (items, mode) => {
    const r = rank(items, ['--mode', mode, '--top', '20', '--min-evidence', '1']);
    return (id) => (r.ranked.find((x) => x.id === id) || { flags: ['not-ranked'] }).flags;
  };
  const FEW = 'few-reviews-for-sales';
  const few = flagsOf([
    { id: 'under', title: 'pin under', rating: 4.8, reviews: 99, sold: 5000 },  // 1.98%
    { id: 'at', title: 'pin at', rating: 4.8, reviews: 100, sold: 5000 },       // 2.00%
    { id: 'floor', title: 'pin floor', rating: 4.8, reviews: 19, sold: 1000 },  // 1.9% at the floor
    { id: 'below', title: 'pin below', rating: 4.8, reviews: 15, sold: 999 },   // 1.5% under the floor
  ], 'final');
  eq('R-F24: few-reviews-for-sales fires under 2% of sold, not at 2%', [few('under').includes(FEW), few('at').includes(FEW)], [true, false]);
  eq('R-F24: few-reviews-for-sales needs a sold of 1,000 or more', [few('floor').includes(FEW), few('below').includes(FEW)], [true, false]);
  const sat = flagsOf([
    { id: 'top', title: 'pin top', rating: 4.8, sold: 10000, soldBucketed: true },
    { id: 'under', title: 'pin under', rating: 4.8, sold: 9999, soldBucketed: true },
    { id: 'raw', title: 'pin raw', rating: 4.8, soldRaw: '10,000+' },
    { id: 'exact', title: 'pin exact', rating: 4.8, sold: 12000, soldBucketed: false },
  ], 'shortlist');
  eq('R-F24: sold-saturated fires on a bucketed sold of 10,000 and up only', ['top', 'under', 'raw', 'exact'].map((id) => sat(id).includes('sold-saturated')),
    [true, false, true, false]);
  const br = flagsOf([
    { id: 'low', title: 'pin low', rating: 4.8, reviews: 500, sold: 5000, brandScore: 0.19 },
    { id: 'at', title: 'pin at', rating: 4.8, reviews: 500, sold: 5000, brandScore: 0.2 },
  ], 'final');
  eq('R-F24: brand-implausible fires under a brandScore of 0.2, not at 0.2', [br('low').includes('brand-implausible'), br('at').includes('brand-implausible')], [true, false]);
  // The docs state the same thresholds.
  eq('R-F24: SKILL.md step 5 says few-reviews-for-sales fires below 2%', numIn(/flags\s+`few-reviews-for-sales`\s+below\s+(\d+)%/, skillSrc), PIN.fewShare * 100);
  eq('R-F24: the SKILL.md flags list names the few-reviews-for-sales rule',
    [numIn(/`few-reviews-for-sales`\s+\(reviews\s+under\s+(\d+)%\s+of\s+a\s+sold\s+count/, skillSrc),
      numIn(/`few-reviews-for-sales`\s+\(reviews\s+under\s+\d+%\s+of\s+a\s+sold\s+count\s+of\s+([\d,]+)\s+or\s+more\)/, skillSrc)],
    [PIN.fewShare * 100, PIN.fewMinSold]);
  eq('R-F24: the SKILL.md flags list says sold-saturated is a bucketed sold of 10,000+',
    numIn(/`sold-saturated`\s+\(a\s+bucketed\s+sold\s+of\s+([\d,]+)\+\)/, skillSrc), PIN.soldSaturated);
  eq('R-F24: the SKILL.md flags list says brand-implausible is a brandScore under 0.2',
    (skillSrc.match(/`brand-implausible`\s+\(a\s+`brandScore`\s+under\s+(0\.\d+):/) || [])[1], String(PIN.brandImplausible));
});

// ============================================================================
// 2026-10-19, recheck of the first fix pass: skeptics found the fixes for
// F00, F20, F32, F15 and F17 too wide or too narrow, and F09-F12 not fixed.
// Each block fails on the 2026-10-18c baseline; the guards against the
// first pass's over-wide rules fail on that pass's code.
// ============================================================================
const { spawnSync: spawnSyncX } = await import('node:child_process');
// rank.mjs with its exit code and stderr (rank() above throws on exit 2).
const rankRun = (input, args) => {
  const r = spawnSyncX(process.execPath, [RANK, ...args], { input: JSON.stringify(input), encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch (e) { out = null; }
  return { code: r.status, out, err: r.stderr || '' };
};

console.log('\nR-F00-2: relevance: "-es" comes off only after s, x, z, ch, sh or o');
await block('R-F00-2', async () => {
  const { queryRelevance: qr } = await import('./lib.mjs');
  // Plurals the narrow rule still joins (the baseline missed all of them).
  for (const [q, t] of [['boxes', 'Storage Box'], ['tax', 'Taxes Calculator'], ['hero', 'Super Heroes Figure'],
    ['potato', 'Potatoes Peeler'], ['gas', 'Gases Detector'], ['lens', 'Camera Lenses'], ['dress', 'Party Dresses']]) {
    eq(`R-F00-2: "${q}" over "${t}" titles raises nothing`, qr(q, recheckRep(t)).warning, null);
  }
  // Off streams the first fix let through ("tubes" gave "tub", "tapes" gave "tap").
  for (const [q, t] of [['bath tub', 'Silicone Tubes Lab'], ['tap', 'Waterproof Duct Tapes'], ['cap', 'Halloween Superhero Capes'],
    ['yoga mat', 'Best Mates Mug'], ['pin', 'Pines Wall Art'], ['tapes', 'Faucet Tap Kitchen'], ['led strip', 'Zebra Stripes Fabric'],
    ['pan', 'Window Panes Film'], ['win', 'Red Wines Glass'], ['notes', 'Not Today Sign']]) {
    ok(`R-F00-2: "${q}" over "${t}" titles still warns`, qr(q, recheckRep(t)).warning !== null, JSON.stringify(qr(q, recheckRep(t)).keywordShare));
  }
  // Through the harvester, so the inlined copy (and dist/) is exercised too.
  const run = async (query, title) => {
    const items = Array.from({ length: 6 }, (_, i) => makeItem('t' + i, { title: title + ' ' + i }));
    const H = loadHarvest(async (url) => { const p = Number(new URL(url).searchParams.get('page'));
      return reply(makePage({ items: p === 1 ? items : [], page: p })); });
    H.start({ query });
    await H.step(3);
    return JSON.parse(H.payload());
  };
  const tub = await run('bath tub', 'Silicone Tubes Lab');
  eq('R-F00-2: harvest.js calls "bath tub" over "Tubes" titles off-query', [tub.coverage.verdict, tub.coverage.streamVerdict], ['off-query', 'exhausted-all-results']);
  const box = await run('boxes', 'Storage Box Organizer');
  eq('R-F00-2: harvest.js calls "boxes" over "Box" titles exhausted-all-results', box.coverage.verdict, 'exhausted-all-results');
  ok('R-F00-2: SKILL.md says "tubes" is not "tub"', /`tubes` is not `tub`/.test(skillSrc));
});

console.log('\nR-F20-2: relevance: a plain "-s" comes off only when 3 letters stay');
await block('R-F20-2', async () => {
  const { queryRelevance: qr } = await import('./lib.mjs');
  for (const [q, t] of [['mug', 'Coffee Mugs'], ['jar', 'Glass Jars'], ['fan', 'USB Fans'], ['mugs', 'Coffee Mug'], ['key', 'Car Keys']]) {
    eq(`R-F20-2: "${q}" over "${t}" titles raises nothing`, qr(q, recheckRep(t)).warning, null);
  }
  for (const [q, t] of [['ups battery', 'Push Up Bra Lace'], ['car', 'Skin Cares Serum'], ['kites', 'Tool Kit Box'],
    ['can', 'Walking Canes Wood'], ['hat', 'Hates Mug Funny'], ['cub', 'Ice Cubes Tray']]) {
    ok(`R-F20-2: "${q}" over "${t}" titles still warns`, qr(q, recheckRep(t)).warning !== null, JSON.stringify(qr(q, recheckRep(t)).keywordShare));
  }
  const items = Array.from({ length: 6 }, (_, i) => makeItem('u' + i, { title: 'Push Up Bra Lace ' + i }));
  const H = loadHarvest(async (url) => { const p = Number(new URL(url).searchParams.get('page'));
    return reply(makePage({ items: p === 1 ? items : [], page: p })); });
  H.start({ query: 'ups battery' });
  const st = await H.step(3);
  eq('R-F20-2: harvest.js: "ups battery" over "Push Up" titles is off-query', [st.relevance.share, st.relevance.offQuery], [0, true]);
});

console.log('\nR-F32-2: relevance: a decode.mjs merge keeps the stream verdict; a join never rebuilds an ending');
await block('R-F32-2', async () => {
  const { queryRelevance: qr } = await import('./lib.mjs');
  const { mergePayloads } = await import('./decode.mjs');
  // A correct synonym stream read in two runs: pages 1-2, then from page 3.
  const ts = ['Wireless Earbuds Bluetooth 5.3 TWS', 'In-ear Earbuds Sport', 'Bluetooth Headset Earbud'];
  const site = async (url) => { const p = Number(new URL(url).searchParams.get('page'));
    return reply(makePage({ items: p > 3 ? [] : Array.from({ length: 20 }, (_, i) => makeItem(`e-${p}-${i}`, { title: ts[i % 3] + ' v' + p + i })), page: p })); };
  const part = async (opts) => { const H = loadHarvest(site); H.start({ query: 'earphones', ...opts }); await H.step(10); return JSON.parse(H.payload()); };
  const a = await part({ maxPages: 2 });
  const b = await part({ startPage: 3 });
  const m = mergePayloads([a, b]);
  eq('R-F32-2: the merge is off-query (the check cannot see a synonym)', m.coverage.verdict, 'off-query');
  eq('R-F32-2: and keeps the stream\'s own verdict', [m.coverage.streamVerdict, m.coverage.byQuery[0].streamVerdict], ['exhausted-all-results', 'exhausted-all-results']);
  const offOf = (x) => ((x && x.relevance) || {}).offSample || [];
  ok('R-F32-2: and the off titles, top level and per stream', offOf(m).length === 3 &&
    (m.coverage.byQuery[0].offSample || []).length === 3 && offOf(m).every((t) => /Earbud|Headset/.test(t)), JSON.stringify(m.relevance));
  const mm = mergePayloads([m, a]);
  eq('R-F32-2: a merged file merged again keeps them', [mm.coverage.streamVerdict, offOf(mm).length], ['exhausted-all-results', 3]);
  // A truncated merge says truncated in both fields.
  const t = mergePayloads([a, await part({ startPage: 2, maxPages: 2 })]);
  eq('R-F32-2: a merge that never ran dry has streamVerdict truncated', [t.coverage.verdict, t.coverage.streamVerdict], ['off-query', 'truncated']);
  // Split compounds still match; a one-letter word or an ending never joins.
  eq('R-F32-2: "wifi camera" over "Wi Fi Cam" titles raises nothing', qr('wifi camera', recheckRep('Wi Fi Cam Home')).warning, null);
  for (const [q, tt] of [['wired usb mouse', 'Copper Wire D Ring Buckle'], ['cart', 'Car T Shirt Funny'], ['wired usb mouse', 'Craft Wire Ed Spool']]) {
    ok(`R-F32-2: "${q}" over "${tt}" titles still warns`, qr(q, recheckRep(tt)).warning !== null, JSON.stringify(qr(q, recheckRep(tt)).keywordShare));
  }
  ok('R-F32-2: lib.mjs no longer says the check "must never fire on a correct stream"', !/must never fire on a correct stream/.test(SRC('lib.mjs')) &&
    /so on such a correct stream the check DOES fire/.test(SRC('lib.mjs')));
  ok('R-F32-2: nor does harvest.js', !/must never fire on a correct stream/.test(harvestText));
  ok('R-F32-2: SKILL.md says a merge keeps relevance.offSample and coverage.streamVerdict',
    /A `decode\.mjs` merge keeps the same two fields:\s+`relevance\.offSample`, and `coverage\.streamVerdict` for the whole merge/.test(skillSrc));
  ok('R-F32-2: SKILL.md names the join limit ("Car Pet" for "carpet")', /`Car Pet\s+Seat Cover` for `carpet`/.test(skillSrc));
});

console.log('\nR-F15-2: listing.js: the page title decides whether "box" is the product; packaging words stay cartons');
await block('R-F15-2', async () => {
  const MOUSE = 'Wired USB Mouse Optical - AliExpress';
  const LUNCH = 'Bento Lunch Box for Kids Leakproof - AliExpress';
  const p = (t, title) => leListing([leEl('P', { text: t })], { title });
  // A box product, with its title: its own size (the baseline said carton).
  eq('R-F15-2: "Lunch Box Size" on a lunch box page is the product size', leSizes(await p('Lunch Box Size: 20 x 15 x 6 cm', LUNCH)),
    [['Lunch Box Size: 20 x 15 x 6 cm'], []]);
  eq('R-F15-2: the same in a fetched description', leSizes(await leListing([], { desc: { body: 'Lunch Box Size: 20 x 15 x 6 cm' }, title: LUNCH })),
    [['Lunch Box Size: 20 x 15 x 6 cm'], []]);
  const HE_LUNCH = 'קופסת אוכל לילדים - AliExpress';
  eq('R-F15-2: Hebrew "גודל קופסה לאוכל" on a box page is the product size', leSizes(await p('גודל קופסה לאוכל: 20x15x6 ס"מ', HE_LUNCH)),
    [['גודל קופסה לאוכל: 20x15x6 ס"מ'], []]);
  eq('R-F15-2: Hebrew "גודל קופסה:" (box size) on a box page is still the carton', leSizes(await p('גודל קופסה: 22x17x8 ס"מ', HE_LUNCH)),
    [[], ['גודל קופסה: 22x17x8 ס"מ']]);
  eq('R-F15-2: Hebrew "קופסת מתנה" (gift box) is the carton', leSizes(await p('גודל קופסת מתנה: 12x7x4 ס"מ', MOUSE)),
    [[], ['גודל קופסת מתנה: 12x7x4 ס"מ']]);
  // A product that is not a box: every box size is the carton.
  for (const t of ['White box size: 15x10x5cm', 'Single box size: 15x10x5cm', 'Brown box size: 15x10x5cm', 'Neutral box size: 15x10x5cm',
    'Display box size: 15x10x5cm', 'Individual box size: 15x10x5cm', 'Product box size: 15x10x5cm', 'Master box size: 40x30x20cm',
    'Material: ABS Box size: 12x7x4cm', 'Lunch Box Size: 20 x 15 x 6 cm']) {
    eq(`R-F15-2: "${t}" on a mouse page is the carton`, leSizes(await p(t, MOUSE)), [[], [t]]);
  }
  // With no title known, the packaging words and the glued label still mean the carton.
  for (const t of ['White box size: 15x10x5cm', 'Master box size: 40x30x20cm', 'Material: ABS Box size: 12x7x4cm', 'Color: Black Box size: 12x7x4cm']) {
    eq(`R-F15-2: "${t}" with no page title is the carton`, leSizes(await p(t)), [[], [t]]);
  }
  // What must not change: a mouse page's own size, and a box page's packaging.
  eq('R-F15-2: "Size: 12 x 6 x 4 cm" on a mouse page is the product size', leSizes(await p('Size: 12 x 6 x 4 cm', MOUSE)), [['Size: 12 x 6 x 4 cm'], []]);
  eq('R-F15-2: "Gift box size" on a lunch box page is the carton', leSizes(await p('Gift box size: 22x17x8cm', LUNCH)), [[], ['Gift box size: 22x17x8cm']]);
  eq('R-F15-2: "White box size" on a lunch box page is the carton', leSizes(await p('White box size: 22x17x8cm', LUNCH)), [[], ['White box size: 22x17x8cm']]);
  ok('R-F15-2: SKILL.md says the product title decides first', /The product title decides first:\s+when the page title holds no "box" \(or קופס\), every box size is the\s+carton/.test(skillSrc));
});

console.log('\nR-F17-2: step 5: a comma or a dot after "Reviews" is a separator, never lost');
await block('R-F17-2', async () => {
  const more = 'More to love 4.8800+ sold cute toy 4.9 5479 Reviews';
  eq('R-F17-2: "Reviews, 10,000+ sold" after an earlier sold text gives 10,000+', leStep5([], more + ', 10,000+ sold US $1.58').out.soldRaw, '10,000+');
  eq('R-F17-2: "Reviews. 10,000+ sold" gives 10,000+', leStep5([], more + '. 10,000+ sold').out.soldRaw, '10,000+');
  eq('R-F17-2: "Reviews,10,000+ sold" gives 10,000+', leStep5([], '4.9 5479 Reviews,10,000+ sold').out.soldRaw, '10,000+');
  // The F17 cases with no separator (the baseline lost a digit).
  eq('R-F17-2: "Reviews 1.2K sold" gives 1.2K', leStep5([], '4.9 5479 Reviews 1.2K sold').out.soldRaw, '1.2K');
  eq('R-F17-2: "Reviews 4.000+ נמכרו" gives 4.000+', leStep5([], '4.9 5479 Reviews 4.000+ נמכרו').out.soldRaw, '4.000+');
  eq('R-F17-2: "Reviews10,000+ sold" gives 10,000+', leStep5([], '4.9 5479 Reviews10,000+ sold').out.soldRaw, '10,000+');
  // What must not change.
  eq('R-F17-2: the live separator still works', leStep5([], RV.gyro).out.soldRaw, '50,000+');
  // Reversed on 2026-10-19 (R-SALES): this pinned the page-wide fallback,
  // and live that fallback returned a related item's card ("4.9202 sold")
  // as the listing's count. Text that is not the header is never read.
  eq('R-F17-2: "Reviews (5479) 300 sold" is not a header count: soldRaw null', leStep5([], 'Reviews (5479) 300 sold').out.soldRaw, null);
});

console.log('\nR-F09: rank.mjs refuses one-hyphen, upper-case and em-dash flags and stray words (exit 2)');
await block('R-F09', async () => {
  const f2 = [{ id: 'a', title: 'x', rating: 4.8, ownRating: 4.8, reviews: 500, sold: 5000, constraints: { wires: 'pass' } },
    { id: 'b', title: 'y', rating: 4.9, ownRating: 4.9, reviews: 900, sold: 5000, constraints: { wires: 'fail' } }];
  const EM = String.fromCharCode(0x2014), EN = String.fromCharCode(0x2013);
  for (const [args, tok] of [[['-constraint', 'wires'], '-constraint'], [['--Constraint', 'wires'], '--Constraint'],
    [[EM + 'constraint', 'wires'], EM + 'constraint'], [[EN + 'constraint', 'wires'], EN + 'constraint'],
    [['--CONSTRAINT=wires'], '--CONSTRAINT=wires'], [['-top', '1'], '-top'], [['--Top', '1'], '--Top'], [['--top', '1', 'extra'], 'extra']]) {
    const r = rankRun(f2, ['--mode', 'final', ...args]);
    ok(`R-F09: ${JSON.stringify(args)} exits 2 and names ${JSON.stringify(tok)}`, r.code === 2 && r.err.includes(JSON.stringify(tok)) && r.out === null,
      `exit ${r.code} ${r.err.slice(0, 120)}`);
  }
  // What must not change.
  const good = rankRun(f2, ['--mode', 'final', '--constraint', 'wires']);
  eq('R-F09: --constraint wires still ranks only the item that passes', [good.code, good.out.constraints, good.out.ranked.map((x) => x.id)], [0, ['wires'], ['a']]);
  const eqf = rankRun(f2, ['--mode=final', '--top=1']);
  eq('R-F09: --name=value still works', [eqf.code, eqf.out.mode, eqf.out.ranked.length], [0, 'final', 1]);
  const neg = rankRun(f2, ['--mode', 'final', '--min-rating', '-1']);
  eq('R-F09: a value that starts with one hyphen is still a value', [neg.code, neg.out.ranked.length], [0, 2]);
  const miss = rankRun(f2, ['--top', '--mode', 'final']);
  ok('R-F09: a flag followed by a flag still names the missing value', miss.code === 2 && /--top needs a value/.test(miss.err), miss.err);
  ok('R-F09: SKILL.md says one-hyphen, upper-case and em-dash flags and stray words exit 2',
    /So are a\s+flag with one hyphen \(`-constraint`\), in upper case \(`--Constraint`\) or with\s+an em dash from autocorrect in place of `--`, a stray word/.test(skillSrc));
});

console.log('\nR-F10: rank.mjs reads a brandScore string and sets aside one outside 0..1');
await block('R-F10', async () => {
  const pool = (bs) => [{ id: 'fake', title: 't', rating: 4.9, ownRating: 4.9, reviews: 2000, sold: 10000, soldRaw: '10,000+', brandScore: bs },
    { id: 'ok', title: 't', rating: 4.8, ownRating: 4.8, reviews: 1500, sold: 5000, brandScore: 0.8 },
    { id: 'house', title: 't', rating: 4.8, ownRating: 4.8, reviews: 1500, sold: 5000, brandScore: 0.5 }];
  const num = rank(pool(0.05), ['--mode', 'final']);
  const str = rank(pool('0.05'), ['--mode', 'final']);
  eq('R-F10: brandScore "0.05" ranks like 0.05', str.ranked.map((x) => [x.id, x.score]), num.ranked.map((x) => [x.id, x.score]));
  ok('R-F10: and is flagged brand-implausible', str.ranked.find((x) => x.id === 'fake').flags.includes('brand-implausible'), JSON.stringify(str.ranked.map((x) => x.flags)));
  for (const bs of [8, -3, 1.5]) {
    const r = rank(pool(bs), ['--mode', 'final']);
    ok(`R-F10: brandScore ${bs} is set aside, not ranked`, !r.ranked.some((x) => x.id === 'fake') && r.droppedReasons['brandScore-out-of-range'] === 1,
      JSON.stringify([r.ranked.map((x) => x.id), r.droppedReasons]));
    ok(`R-F10: brandScore ${bs} is named in a warning`, r.warnings.some((w) => /^brandScore-out-of-range/.test(w) && w.includes('fake:' + bs)), JSON.stringify(r.warnings));
  }
  const abc = rank(pool('abc'), ['--mode', 'final']);
  ok('R-F10: brandScore "abc" is set aside as not-a-number', abc.droppedReasons['not-a-number:brandScore'] === 1 && abc.warnings.some((w) => /^not-a-number/.test(w)),
    JSON.stringify(abc.droppedReasons));
  // What must not change: 0 and 1 are in range, and no brandScore is neutral.
  const edge = rank([{ ...pool(0)[0] }, { ...pool(0)[1], brandScore: 1 }, { ...pool(0)[2], brandScore: undefined }], ['--mode', 'final']);
  eq('R-F10: brandScore 0 and 1 are ranked, a missing one is neutral', [edge.ranked.length, edge.brandDefaulted, edge.droppedCount], [3, 1, 0]);
  ok('R-F10: SKILL.md says an out-of-range or non-number brandScore is set aside', /sets aside an item\s+whose score is not a number or is outside 0\.\.1, with a warning/.test(skillSrc));
});

console.log('\nR-F11: rank.mjs never drops a finalist without a word');
await block('R-F11', async () => {
  const good = { id: 'good', title: 'x', rating: 4.8, ownRating: 4.8, reviews: 500, sold: 5000 };
  const heb = { id: 'heb', title: 'y', rating: null, ownRating: null, reviews: null, pooledReviews: null, soldRaw: '1,000+' };
  const r = rank([good, heb], ['--mode', 'final']);
  eq('R-F11: a finalist with no rating and no counts is own-reviews-unknown, not "no rating"', [r.ranked.map((x) => x.id), r.droppedReasons],
    [['good'], { 'own-reviews-unknown': 1 }]);
  ok('R-F11: and is named in the own-reviews-unknown warning', r.warnings.some((w) => /^own-reviews-unknown/.test(w) && w.includes('heb')), JSON.stringify(r.warnings));
  const r2 = rank([good, { id: 'pool', title: 'z', rating: null, reviews: null, pooledReviews: 5479 }], ['--mode', 'final']);
  eq('R-F11: with only a pooled count, the same', r2.droppedReasons, { 'own-reviews-unknown': 1 });
  const r3 = rank([good, { id: 'hand', title: 'w', rating: null, reviews: 300 }], ['--mode', 'final']);
  ok('R-F11: an own count but no rating is set aside with a no-rating warning', r3.droppedReasons['no rating'] === 1 &&
    r3.warnings.some((w) => /^no-rating/.test(w) && w.includes('hand')), JSON.stringify([r3.droppedReasons, r3.warnings]));
  // What must not change: in shortlist mode SEO junk is dropped quietly.
  const s = rank([{ id: 'k', title: 'x', rating: 4.8, sold: 5000 }, { id: 'junk', title: 'seo', rating: null, reviews: null, sold: null }], ['--mode', 'shortlist']);
  eq('R-F11: shortlist: SEO junk is "no rating", no warning', [s.droppedReasons, s.warnings], [{ 'no rating': 1 }, []]);
  ok('R-F11: SKILL.md says such a finalist is own-reviews-unknown also with no rating', /named in a warning, also when it has no rating at all/.test(skillSrc));
});

console.log('\nR-F12: rank.mjs: a bad --require regex is a bad flag value (exit 2), not a stack trace');
await block('R-F12', async () => {
  const f1 = [{ id: 'm', title: 'wired mouse', rating: 4.8, sold: 5000 }];
  for (const args of [['--require', '('], ['--require=('], ['--require', '[a-']]) {
    const r = rankRun(f1, args);
    ok(`R-F12: ${JSON.stringify(args)} exits 2 and names --require`, r.code === 2 && /--require is not a valid regular expression/.test(r.err) && !/at new RegExp/.test(r.err),
      `exit ${r.code} ${r.err.slice(0, 160)}`);
  }
  const blank = rankRun(f1, ['--require', ' ']);
  ok('R-F12: a blank --require exits 2', blank.code === 2 && /--require needs a regex/.test(blank.err), `exit ${blank.code} ${blank.err.slice(0, 120)}`);
  const good = rankRun(f1, ['--require', 'mouse|maus']);
  eq('R-F12: a valid regex still filters', [good.code, good.out.ranked.map((x) => x.id)], [0, ['m']]);
  ok('R-F12: SKILL.md says a bad --require regex exits 2', /a blank\s+`--require ''` and a `--require` regex that does not compile/.test(skillSrc));
});

console.log('\nR-SPEC-MORE: the spec table\'s "View more" is clicked before its rows are read (live 2026-10-19)');
await block('R-SPEC-MORE', async () => {
  /* Live, signed-in Chrome, 2026-10-19: the Specifications table showed 6
   * rows; "Type: Bluetooth Wireless" appeared only after its "View more"
   * button (class comet-v2-btn ... specification--btn--...) was clicked:
   * 15 rows in the same call, and the button was then removed. The step-5
   * reader never clicked it, so a "wireless" requirement looked unknown. */
  const row = (k, val) => ({ className: 'specification--prop--J', textContent: k + val, shadowRoot: null,
    querySelector: (sel) => (/title/.test(sel) ? { textContent: k } : /desc/.test(sel) ? { textContent: val } : null) });
  const ldj = [{ textContent: JSON.stringify({ '@type': 'Product', aggregateRating: { ratingValue: '4.8', reviewCount: '1026' }, offers: { price: '8.49', priceCurrency: 'USD' } }) }];
  const page = () => {
    const els = [row('Power Type', 'Rechargeable'), row('Number of Rollers', '1 pcs')];
    const hidden = [row('Interface Type', 'Bluetooth'), row('Battery Included', 'Yes'), row('Type', 'Bluetooth Wireless')];
    const clicks = { spec: 0, review: 0 };
    const btn = { className: 'comet-v2-btn comet-v2-btn-slim comet-v2-btn-large specification--btn--Y4pYc4b', textContent: 'View more',
      shadowRoot: null, querySelector: () => null,
      click() { clicks.spec++; els.splice(els.indexOf(btn), 1); els.push(...hidden); } };
    const review = { className: 'comet-v2-btn comet-v2-btn-slim comet-v2-btn-large', textContent: 'View more', shadowRoot: null,
      querySelector: () => null, click() { clicks.review++; } };
    els.push(review, btn);
    const document = { title: 'Mouse', body: { innerText: RV.gyro }, querySelectorAll: (sel) => (/ld\+json/.test(sel) ? ldj : [...els]) };
    return { document, clicks };
  };
  const s5 = (pg) => JSON.parse(new Function('document', 'location', 'return (' + step5 + '\n)')(pg.document, { pathname: '/item/1005008556584698.html' }));
  const p1 = page();
  const g1 = s5(p1);
  eq('R-SPEC-MORE: step 5 reads the rows behind "View more"', g1.spec,
    { 'Power Type': 'Rechargeable', 'Interface Type': 'Bluetooth', 'Battery Included': 'Yes', Type: 'Bluetooth Wireless' });
  eq('R-SPEC-MORE: step 5 clicks the spec button once and says so', [p1.clicks.spec, g1.specMore], [1, 1]);
  eq('R-SPEC-MORE: step 5 does not click the reviews "View more"', p1.clicks.review, 0);
  const g1b = s5(p1);
  eq('R-SPEC-MORE: a second run finds no button and still reads every row', [g1b.specMore, g1b.spec.Type, p1.clicks.spec], [0, 'Bluetooth Wireless', 1]);

  // listing.js: expand() clicks "View more" leaves by text, at most 8. Eight
  // earlier ones (review images, review list, related items) use up the cap,
  // so the spec button must be clicked by its class.
  const src = RUN('listing.js');
  const leaf = (tag, p = {}) => ({ tagName: tag, children: [], textContent: p.text || '', className: p.cls || '',
    naturalWidth: 0, naturalHeight: 0, currentSrc: '', src: '', shadowRoot: null, parentElement: null,
    getAttribute: () => null, querySelector: () => null, querySelectorAll: () => p.qsa || [],
    closest: () => null, click: p.click || (() => {}), id: '', nodeType: 1,
    childNodes: p.text ? [{ nodeType: 3, nodeValue: p.text }] : [] });
  const lrow = (k, val) => { const t = leaf('DIV', { cls: 'specification--title--S', text: k }); const v = leaf('DIV', { cls: 'specification--desc--D', text: val });
    return [leaf('DIV', { cls: 'specification--prop--J', qsa: [t, v] }), t, v]; };
  const lpage = (decoys) => {
    const els = [];
    for (let i = 0; i < decoys; i++) els.push(leaf('SPAN', { text: 'View more', cls: 'list-customer-show--mask--G' }));
    els.push(...lrow('Power Type', 'Rechargeable'));
    let specClicks = 0;
    const btn = leaf('BUTTON', { cls: 'comet-v2-btn comet-v2-btn-large specification--btn--Y4pYc4b', text: 'View more',
      click: () => { specClicks++; els.splice(els.indexOf(btn), 1); els.push(...lrow('Type', 'Bluetooth Wireless')); } });
    els.push(btn);
    const document = { body: { scrollHeight: 5000, innerText: 'x'.repeat(2500) }, documentElement: { outerHTML: '' },
      querySelectorAll: (sel) => (/ld\+json/.test(sel || '') ? [] : [...els]) };
    const L = new Function('window', 'document', 'location', `${src}; return window.__aeListing;`)({ scrollTo() {}, document }, document, { href: 'https://he.aliexpress.com/item/1.html' });
    return { L, clicks: () => specClicks };
  };
  const l1 = lpage(8);
  const r1 = await l1.L.read({ description: false });
  eq('R-SPEC-MORE: listing.js reads the hidden Type row though 8 other "View more" used the expand() cap',
    [r1.specs.Type, r1.specsSource], ['Bluetooth Wireless', 'dom']);
  eq('R-SPEC-MORE: listing.js clicked the spec button once and reports it', [l1.clicks(), r1.specExpanded], [1, 1]);
  const l2 = lpage(0);
  const r2 = await l2.L.read({ description: false });
  eq('R-SPEC-MORE: with no decoys the button is still clicked only once', [l2.clicks(), r2.specs.Type], [1, 'Bluetooth Wireless']);
  const l3 = lpage(0);
  const r3 = await l3.L.read({ description: false, expand: false });
  eq('R-SPEC-MORE: read({ expand: false }) clicks nothing', [l3.clicks(), r3.specExpanded, r3.specs.Type], [0, 0, undefined]);
  ok('R-SPEC-MORE: SKILL.md says the reader clicks the spec "View more" first', /clicks the Specifications table's\s+"View more" button first/.test(skillSrc));
});

console.log('\nR-SALES: step 5 reads "sales" in the header and never another product\'s "sold" (live 2026-10-19)');
await block('R-SALES', async () => {
  /* Live, signed-in Chrome, 2026-10-19, item 1005007386086113 (AJAZZ AJ179):
   * the header said "4.8 2571 Reviews ౹ 10,000+ sales ౹ 10,000+
   * cross-platform sales". The reader matched only "sold", so it fell back
   * to the first "sold" on the page: a related item's card, "Cover
   * Universal Cover Cheap Replacement 4.9202 sold" (a 4.9 rating next to
   * 202 sold), and returned soldRaw "4.9202" as this listing's count. */
  const card = 'Outdoor Garden Furniture Cover Universal Cover Cheap Replacement 4.9202 sold US $11.36 ';
  const live = card + 'AJAZZ AJ179 Lightweight Wired And Wireless Mouse 4.8 2571 Reviews ౹ 10,000+ sales ౹ 10,000+ cross-platform sales US $30.59';
  const a = leStep5([], live).out;
  eq('R-SALES: the live header "10,000+ sales" gives 10,000+ from the header', [a.soldRaw, a.soldFrom], ['10,000+', 'header']);
  const b = leStep5([], card + '4.8 2571 Reviews ౹ 10,000+ cross-platform sales').out;
  eq('R-SALES: "cross-platform sales" alone is not this listing\'s count, and the card is never read', [b.soldRaw, b.soldFrom], [null, 'none']);
  const c = leStep5([], 'More to love ' + card + 'nothing else').out;
  eq('R-SALES: with no header count, soldRaw is null, never a card\'s "4.9202"', [c.soldRaw, c.soldFrom], [null, 'none']);
  eq('R-SALES: "Reviews ౹ 455 sales" gives 455', leStep5([], '4.8 37 Reviews ౹ 455 sales').out.soldRaw, '455');
  eq('R-SALES: "Reviews ౹ 100K+ sales" gives 100K+', leStep5([], '4.9 4779 Reviews ౹ 100K+ sales').out.soldRaw, '100K+');
  const d = leStep5([], RV.gyro).out;
  eq('R-SALES: the "sold" header still works and says header', [d.soldRaw, d.soldFrom], ['50,000+', 'header']);
  eq('R-SALES: the Hebrew header still works', leStep5([], RV.hebrew).out.soldRaw, '50,000+');
  ok('R-SALES: SKILL.md says only the header counts and names "sales"', /`soldRaw`\*\* comes from the header only/.test(skillSrc) &&
    /Reviews ౹ 10,000\+ sales/.test(skillSrc) && /use the search grid's `soldRaw`/.test(skillSrc));
});

console.log('\nR-BRAND: relevance: a brand word or a connector word alone does not make a stream the product (live 2026-10-19)');
await block('R-BRAND', async () => {
  /* Live, signed-in Chrome, 2026-10-19. "poco f7 ultra wallet case" was
   * served as 143 POCO items (phones, tablets, 1 tablet case, 2 fee links)
   * and "type c iem" as 49 items (USB-C cables and chargers, flash drives,
   * nail tips, car lights). The old check passed both (share 0.979 and
   * 0.857) as exhausted-all-results. The titles, and those of three correct
   * streams of the same day, are in fixtures/real-streams-2026-10-19.json. */
  const { queryRelevance: qr } = await import('./lib.mjs');
  const fx = JSON.parse(SRC('fixtures/real-streams-2026-10-19.json'));
  const phones = qr(fx.pocoPhones.query, fx.pocoPhones.titles);
  ok('R-BRAND: the real POCO phone stream warns for "poco f7 ultra wallet case"', /^off-query-keywords: 3 of the 5 keywords/.test(phones.warning || ''),
    String(phones.warning).slice(0, 80));
  eq('R-BRAND: it names the keywords the titles lack', phones.missingKeywords, ['f7', 'wallet', 'case']);
  ok('R-BRAND: the warning quotes 3 titles to read', phones.offSample.length === 3 && phones.warning.includes(JSON.stringify(phones.offSample)),
    JSON.stringify(phones.offSample));
  const cables = qr(fx.iemCables.query, fx.iemCables.titles);
  ok('R-BRAND: the real cable stream warns for "type c iem"', /^off-query-connector: /.test(cables.warning || ''), String(cables.warning).slice(0, 80));
  eq('R-BRAND: "type" is the connector word, and the share still counts it', [cables.connectorKeywords, cables.share], [['type'], 0.857]);
  // "type c 120w" names no goods, and 71% of that page is cables and
  // chargers: its product (R-BRAND-3 pins the 60% limit).
  eq('R-BRAND: "type c 120w" over that page of cables and chargers raises nothing', qr('type c 120w', fx.iemCables.titles).warning, null);
  eq('R-BRAND: on the cable warning, missingKeywords names iem', cables.missingKeywords, ['iem']);
  for (const q of ['type c headset', 'type c hifi']) {
    // Live 2026-10-19: these were served the same page as "type c iem".
    ok(`R-BRAND: "${q}" over that cable page warns (off-query-connector)`, /^off-query-connector: /.test(qr(q, fx.iemCables.titles).warning || ''),
      JSON.stringify(qr(q, fx.iemCables.titles).keywordShare));
  }
  eq('R-BRAND: a query of connector words only is measured on them ("usb type c" over the cables)', qr('usb type c', fx.iemCables.titles).warning, null);
  for (const [k, q] of [['pocoCases', null], ['pocoCases', 'poco f7 ultra wallet case'], ['typeCEarphones', null], ['iemTypeCMic', null]]) {
    const query = q || fx[k].query;
    for (const n of [60, 120, 180, Infinity]) {
      if (n !== Infinity && fx[k].titles.length <= n) continue;
      const ts = fx[k].titles.slice(0, n);
      eq(`R-BRAND: the correct real stream ${k}, first ${ts.length} titles, raises nothing for "${query}"`, qr(query, ts).warning, null);
    }
  }
  /* The first version of this fix (2026-10-19) stopped counting connector
   * words for the share. On the real IEM stream that was a false alarm
   * after 1 or 2 pages (0.483, 0.467), because its titles call an IEM
   * "Earphones" or "In Ear Monitor" and say "Type-C" (review FA-1). */
  eq('R-BRAND: the real IEM stream, pages 1 and 1-2, is not off-query for "iem type c mic"',
    [qr('iem type c mic', fx.iemTypeCMic.titles.slice(0, 60)).share, qr('iem type c mic', fx.iemTypeCMic.titles.slice(0, 120)).warning], [0.55, null]);
  const realMice = JSON.parse(SRC('fixtures/real-titles-2026-10-17.json')).mice.titles;
  for (const q of ['wired usb mouse', 'usb mouse', 'mouse corded', 'usb corded mouse']) {
    eq(`R-BRAND: the real mouse stream raises nothing for "${q}" (usb is a connector word, mouse is not)`, qr(q, realMice).warning, null);
  }
});

console.log('\nR-BRAND-2: relevance: each limit of the two new rules is pinned (review C-1, 2026-10-19)');
await block('R-BRAND-2', async () => {
  const { queryRelevance: qr } = await import('./lib.mjs');
  const realMice = JSON.parse(SRC('fixtures/real-titles-2026-10-17.json')).mice.titles;
  const { mergePayloads } = await import('./decode.mjs');
  const rep = (t, n) => Array.from({ length: n }, (_, i) => t + ' ' + i);
  // off-query-connector: every other keyword under 15% of the titles.
  const at = (k) => rep('Type C Cable Fast Charging', 20 - k).concat(rep('Type C Widget', k));
  eq('R-BRAND-2: "type c widget", widget in 2 of 20 titles (10%): off-query-connector', /^off-query-connector/.test(qr('type c widget', at(2)).warning || ''), true);
  eq('R-BRAND-2: widget in 3 of 20 titles (15%): nothing', qr('type c widget', at(3)).warning, null);
  for (const c of ['usb', 'type', 'lightning', 'thunderbolt', 'hdmi', 'magsafe']) {
    const r = qr(c + ' dock', rep(c + ' Cable 2m Braided', 10));
    eq(`R-BRAND-2: "${c}" is a connector word ("${c} dock" over ${c} cables)`, [r.connectorKeywords, /^off-query-connector/.test(r.warning || '')], [[c], true]);
  }
  eq('R-BRAND-2: a noun is not a connector word ("cable dock" over cables)', qr('cable dock', rep('Cable 2m Braided', 10)).connectorKeywords, []);
  // off-query-keywords: 3 or more missing, and more than half, each under 5%.
  const base = rep('Alpha Gadget Pro', 20);
  eq('R-BRAND-2: 3 of 4 keywords absent: off-query-keywords', /^off-query-keywords: 3 of the 4/.test(qr('alpha beta gamma delta', base).warning || ''), true);
  const oneBeta = base.slice(0, 19).concat(['Alpha Beta Gadget']);
  eq('R-BRAND-2: beta in 1 of 20 titles (5%) is not missing: 2 of 4, nothing', [qr('alpha beta gamma delta', oneBeta).missingKeywords, qr('alpha beta gamma delta', oneBeta).warning], [['gamma', 'delta'], null]);
  eq('R-BRAND-2: 2 missing of 3 is not enough (a two-word brand, two UK spellings)', qr('alpha beta gamma', base).warning, null);
  eq('R-BRAND-2: 3 missing of 6 is half, not more: nothing', qr('alpha gadget pro beta gamma delta', base).warning, null);
  ok('R-BRAND-2: 4 missing of 6: off-query-keywords', /^off-query-keywords: 4 of the 6/.test(qr('alpha gadget beta gamma delta epsilon', base).warning || ''));
  eq('R-BRAND-2: connector words are not counted as missing ("usb alpha beta gamma" over Alpha titles: 2 of 3, nothing)',
    qr('usb alpha beta gamma', base).warning, null);
  // UK spellings, glued connector words, prototype keys.
  const wire = JSON.parse(SRC('fixtures/real-titles-2026-10-17.json')).craftWire.titles;
  eq('R-BRAND-2: "aluminium jewellery wire" over real craft wire raises nothing (UK spelling, review FA-6)', qr('aluminium jewellery wire', wire).warning, null);
  eq('R-BRAND-2: "aluminum wire" over "Aluminium Wire" titles is on-query', qr('aluminum wire', rep('Aluminium Wire 1mm', 10)).share, 1);
  eq('R-BRAND-2: "usbc hub" is "usb hub" over "USB-C Hub" titles (review F7)', [qr('usbc hub', rep('USB-C Hub 7 in 1', 10)).keywords, qr('usbc hub', rep('USB-C Hub 7 in 1', 10)).keywordShare.usb], [['usb', 'hub'], 1]);
  eq('R-BRAND-2: the query word "constructor" is not held by every title (review F6)', qr('constructor', rep('Gaming Mouse', 10)).share, 0);
  // The live captures of 2026-10-19 (fixtures/live-streams-2026-10-19.json).
  const live = JSON.parse(SRC('fixtures/live-streams-2026-10-19.json'));
  const KNOWN_MISS = ['canonEosR50Device'];
  for (const k of Object.keys(live).filter((x) => x !== 'note')) {
    const s = live[k], w = qr(s.query, s.titles).warning;
    if (s.label === 'mixed') {
      // Only the junk page served for "usb c 100w" is pinned: 37% of it is cables.
      if (k === 'usbC100w') ok('R-BRAND-2: live "usb c 100w" (a junk page: flash drives, hubs, some cables) warns', !!w, String(w).slice(0, 60));
      continue;
    }
    if (s.label === 'on') eq(`R-BRAND-2: live "${s.query}" (the product, ${s.titles.length} titles) raises nothing`, w, null);
    else if (KNOWN_MISS.includes(k)) eq(`R-BRAND-2: live "${s.query}" is a known miss (a device query served as its accessories)`, w, null);
    else ok(`R-BRAND-2: live "${s.query}" (${s.label}) warns`, !!w, JSON.stringify(qr(s.query, s.titles).keywordShare));
  }
  // rank.mjs on a merge of two correct streams of different queries (F1).
  const fx = JSON.parse(SRC('fixtures/real-streams-2026-10-19.json'));
  const part = (q, ts, pages) => ({ query: q, source: 'harvest-paged', fourStar: true, coverage: { verdict: 'exhausted-all-results' },
    pages, items: ts.map((t, i) => ({ id: q.slice(0, 4) + i, title: t, rating: 4.8, sold: 500, soldRaw: '500+' })) });
  const mice = part('wired usb mouse', realMice, [{ page: 1, n: 60 }, { page: 2, n: 0 }]);
  const cases = part(fx.pocoCases.query, fx.pocoCases.titles.slice(0, 15), [{ page: 1, n: 15 }, { page: 2, n: 0 }]);
  const m = mergePayloads([mice, cases]);
  const r = rank(m, ['--mode', 'shortlist']);
  eq('R-BRAND-2: a merge of 326 real mice and 15 real POCO cases is not off-query anywhere (review F1)',
    [m.coverage.verdict, r.warnings.filter((w) => /^off-query/.test(w))], ['exhausted-all-results', []]);
  // decode.mjs: a wall at page 2, then a recovery part, of the real IEM stream (F2).
  const iem = fx.iemTypeCMic.titles;
  const A = { ...part(fx.iemTypeCMic.query, iem.slice(0, 120), [{ page: 1, n: 60 }, { page: 2, n: 60 }]), coverage: { verdict: 'truncated' }, blocked: true };
  const B = { ...part(fx.iemTypeCMic.query, iem.slice(120), [3, 4, 5, 6].map((p) => ({ page: p, n: 60 })).concat([{ page: 7, n: 0 }])),
    coverage: { verdict: 'exhausted-from-start-page' } };
  B.items = B.items.map((x, i) => ({ ...x, id: 'iemB' + i }));
  eq('R-BRAND-2: the real IEM stream read as a wall part and a recovery part is complete, not off-query (review F2)', mergePayloads([A, B]).coverage.verdict, 'exhausted-all-results');
  // harvest.js end to end on the real cable stream.
  const items = fx.iemCables.titles.map((t, i) => makeItem('c' + i, { title: t }));
  const H = loadHarvest(async (url) => { const p = Number(new URL(url).searchParams.get('page'));
    return reply(makePage({ items: p === 1 ? items : [], page: p })); });
  H.start({ query: fx.iemCables.query });
  const st = await H.step(3);
  const pl = JSON.parse(H.payload());
  eq('R-BRAND-2: harvest.js calls the real cable stream off-query; it ran dry', [st.relevance.offQuery, pl.coverage.verdict, pl.coverage.streamVerdict],
    [true, 'off-query', 'exhausted-all-results']);
  ok('R-BRAND-2: and its payload carries off-query-connector', pl.warnings.some((w) => /^off-query-connector: /.test(w)), JSON.stringify(pl.warnings));
  // The inlined copy in harvest.js gives the same answer on every fixture stream.
  const blk = harvestText.match(/\/\* @shared:queryRelevance:start \*\/([\s\S]*?)\/\* @shared:queryRelevance:end \*\//);
  const inl = new Function(`${blk[1]}; return queryRelevance;`)();
  const all = [...Object.keys(fx).filter((k) => k !== 'note').map((k) => [fx[k].query, fx[k].titles]),
    ...Object.keys(live).filter((k) => k !== 'note').map((k) => [live[k].query, live[k].titles]),
    ['type c widget', at(2)], ['alpha beta gamma delta', base], ['aluminium jewellery wire', wire], ['usbc hub', rep('USB-C Hub', 10)], ['constructor', rep('Mouse', 10)]];
  eq('R-BRAND-2: harvest.js queryRelevance agrees with lib.mjs on all of them', all.filter(([q, ts]) => JSON.stringify(inl(q, ts)) !== JSON.stringify(qr(q, ts))).length, 0);
  // SKILL.md says what the code does.
  ok('R-BRAND-2: SKILL.md names both warnings, the 15% and 5% limits, the 3-keyword floor and the connector words',
    /`off-query-connector`/.test(skillSrc) && /`off-query-keywords`/.test(skillSrc) && /15%/.test(skillSrc) && /3 or more/.test(skillSrc) &&
    /`type`, `usb`, `lightning`, `thunderbolt`, `hdmi`, `magsafe`/.test(skillSrc));
});


console.log('\nR-BRAND-3: relevance: the second review of the new rules (2026-10-20): fixes and limits pinned');
await block('R-BRAND-3', async () => {
  const { queryRelevance: qr } = await import('./lib.mjs');
  const rep = (t, n) => Array.from({ length: n }, (_, i) => t + ' ' + i);
  const fx = JSON.parse(SRC('fixtures/real-streams-2026-10-19.json'));
  const live = JSON.parse(SRC('fixtures/live-streams-2026-10-19.json'));
  const realMice = JSON.parse(SRC('fixtures/real-titles-2026-10-17.json')).mice.titles;
  // CR-6: rule 1 needs a connector word in half the titles or more.
  const noUsb = ['alpha', 'bravo', 'charlie', 'delta'].flatMap((w) => rep(w + ' Gadget', 14)).concat(rep('Other Thing', 44));
  eq('R-BRAND-3: "usb" in no title: no off-query-connector, though every other keyword is under 15% (CR-6)',
    [qr('usb alpha bravo charlie delta', noUsb).share, qr('usb alpha bravo charlie delta', noUsb).warning], [0.56, null]);
  // CR-2: titles that write "TypeC" or "USBC" as one word.
  eq('R-BRAND-3: "usbc" over "USBC Charger" titles is on-query (CR-2)', qr('usbc', rep('USBC Charger 65W GaN', 20)).share, 1);
  eq('R-BRAND-3: "typec" over "TypeC Charger" titles is on-query', qr('typec', rep('TypeC Charger 65W GaN', 20)).share, 1);
  eq('R-BRAND-3: "typec iem" gives keywords type and iem, and "TypeC" titles hold type', [qr('typec iem', rep('TypeC Earphone IEM', 3).concat(rep('TypeC Cable 1m', 17))).keywords,
    qr('typec iem', rep('TypeC Earphone IEM', 3).concat(rep('TypeC Cable 1m', 17))).keywordShare.type], [['type', 'iem'], 1]);
  // CR-1, FA2-2, MUT-03: the UK map works on plurals, joins and both sides.
  eq('R-BRAND-3: "organiser" over "Organisers" titles is on-query (CR-1)', qr('organiser', rep('Makeup Organisers Acrylic Box', 20)).share, 1);
  eq('R-BRAND-3: UK joins: "grey hound", "centre piece", "jewellery box" over one-word titles raise nothing',
    [qr('grey hound', rep('Greyhound Dog Statue Resin', 10)).warning, qr('centre piece', rep('Wedding Table Centrepiece Gold', 10)).warning,
      qr('jewellery box', rep('Jewellerybox Velvet Ring', 10)).warning], [null, null, null]);
  const us = rep('Aluminum Jewelry Color Wire Craft', 10);
  eq('R-BRAND-3: "aluminium jewellery colour wire" over US titles holds all 4 (3 UK words would be 3 missing)',
    [qr('aluminium jewellery colour wire', us).warning, qr('aluminium jewellery colour wire', us).keywordShare.aluminium], [null, 1]);
  eq('R-BRAND-3: "aluminum" over "Aluminium" titles is on-query (the title side)', qr('aluminum', rep('Aluminium Sheet 1mm', 10)).share, 1);
  eq('R-BRAND-3: "usb c adaptor" over adapter titles raises nothing (FA2-2)', qr('usb c adaptor', rep('USB C to HDMI Adapter 4K', 10)).warning, null);
  // FA2-4, CRIT2-3: "dupe" is a stop word; "magnetic" is "magnet"; "organic" is not "organ".
  const align = qr('lululemon align leggings dupe', live.lululemonAlignLeggings.titles);
  eq('R-BRAND-3: "dupe" is not a keyword, so a real leggings stream lacks 2 of 3, not 3 of 4 (FA2-4)', [align.keywords, align.warning], [['lululemon', 'align', 'leggings'], null]);
  const mag = qr('oxyled fridge magnet light motion', rep('Magnetic LED Cabinet Light with Motion Sensor USB Rechargeable', 10));
  eq('R-BRAND-3: "magnet" is held by "Magnetic" titles (the user\'s query of 2026-10-19, CRIT2-3)', [mag.keywordShare.magnet, mag.warning], [1, null]);
  eq('R-BRAND-3: "organ" is not held by "Organic" titles', qr('organ', rep('Organic Cotton Towel', 10)).share, 0);
  // FA2-1, FA2-3, FA2-5: goods named in other words count for rule 1 only.
  eq('R-BRAND-3: "usb c lead" over the real "usb c 3m" cable page raises nothing (FA2-1)', qr('usb c lead', live.usbC3m.titles).warning, null);
  eq('R-BRAND-3: "type c earpods" over the real USB-C earphone stream raises nothing (FA2-5)', qr('type c earpods', fx.typeCEarphones.titles).warning, null);
  eq('R-BRAND-3: "usb c dongle" over hub titles raises nothing (FA2-3)', qr('usb c dongle', rep('USB C Hub 7 in 1 Adapter', 10)).warning, null);
  ok('R-BRAND-3: the goods table is not used by the share rule ("lead" alone over cables is off-query-results)',
    /^off-query-results/.test(qr('lead', rep('USB C Cable 1m', 10)).warning || ''));
  // The spec-only exemption: a page of cables and chargers for "usb c 2m".
  eq('R-BRAND-3: "usb c 2m" over the real cable page (71% cables and chargers) raises nothing', qr('usb c 2m', fx.iemCables.titles).warning, null);
  const mixPage = (n) => rep('Type C Cable Fast Charging', n).concat(rep('Type C Flash Disk 64GB', 10 - n));
  ok('R-BRAND-3: "type c 2m" over 5 cables and 5 flash disks (50%) warns', /^off-query-connector/.test(qr('type c 2m', mixPage(5)).warning || ''));
  eq('R-BRAND-3: over 6 cables and 4 flash disks (60%) it raises nothing', qr('type c 2m', mixPage(6)).warning, null);
  ok('R-BRAND-3: a query with a noun is never let off: "type c iem" over that 60% page warns', /^off-query-connector/.test(qr('type c iem', mixPage(6)).warning || ''));
  // MUT-04, MUT-05: both limits pinned from below too.
  const b21 = ['Alpha Beta Gadget'].concat(rep('Alpha Gadget', 20));
  ok('R-BRAND-3: beta in 1 of 21 titles (4.8%) is missing: off-query-keywords 3 of 4', /^off-query-keywords: 3 of the 4/.test(qr('alpha beta gamma delta', b21).warning || ''));
  const w21 = rep('Type C Widget', 3).concat(rep('Type C Cable Fast Charging', 18));
  ok('R-BRAND-3: widget in 3 of 21 titles (14.3%): off-query-connector', /^off-query-connector/.test(qr('type c widget', w21).warning || ''));
  // MUT-06: the 5-title floor of both rules.
  eq('R-BRAND-3: 4 titles: neither new rule fires', [qr('type c widget', rep('Type C Cable', 4)).warning, qr('alpha beta gamma delta', rep('Alpha Gadget', 4)).warning], [null, null]);
  ok('R-BRAND-3: 5 titles: both fire', /^off-query-connector/.test(qr('type c widget', rep('Type C Cable', 5)).warning || '') &&
    /^off-query-keywords/.test(qr('alpha beta gamma delta', rep('Alpha Gadget', 5)).warning || ''));
  // MUT-07: offSample on the two new warnings.
  const s2 = ['Alpha Beta Gadget 0'].concat(rep('Alpha Gadget', 39).map((x, i) => x.replace(/ \d+$/, ' ' + (i + 1))));
  eq('R-BRAND-3: off-query-keywords: offSample skips a title that holds a missing keyword', qr('alpha beta gamma delta', s2).offSample, ['Alpha Gadget 1', 'Alpha Gadget 2', 'Alpha Gadget 3']);
  const s1 = ['Type C Widget 0'].concat(rep('Type C Cable', 19).map((x, i) => x.replace(/ \d+$/, ' ' + (i + 1))));
  eq('R-BRAND-3: off-query-connector: offSample skips a title that holds the other keyword', qr('type c widget', s1).offSample, ['Type C Cable 1', 'Type C Cable 2', 'Type C Cable 3']);
  // MUT-08, CR-7: the warning texts.
  const w1 = qr('type c widget', rep('Type C Cable', 20)).warning;
  ok('R-BRAND-3: off-query-connector names the carrier, the limit and the title count, and says not to report all results',
    /matched on the connector word \[type\]/.test(w1) && /fewer than 15% of the 20 titles/.test(w1) && /do not report it as exhausted-all-results/.test(w1), w1);
  const w2 = qr('alpha beta gamma delta', rep('Alpha Gadget', 20)).warning;
  ok('R-BRAND-3: off-query-keywords names the count, the limit and what matched', /3 of the 4 keywords \[beta, gamma, delta\] are each in fewer than 5% of the 20 titles, so the stream matched on \[alpha\] alone/.test(w2) &&
    /do not report it as exhausted-all-results/.test(w2), w2);
  const w3 = qr('usb ' + fx.pocoPhones.query, fx.pocoPhones.titles).warning;
  ok('R-BRAND-3: with a connector word in the query, the count says so and the connector is not "matched" (CR-7)',
    /3 of the 5 keywords that are not connector words/.test(w3) && /matched on \[poco, ultra\] alone/.test(w3), w3);
  const many = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike'];
  const w4 = qr(many.join(' '), many.flatMap((w) => rep(w + ' Thing', 4)).concat(rep('Other Thing', 48))).warning;
  ok('R-BRAND-3: when no keyword is in 5% of the titles, the text says so instead of "[]"', /matched on no keyword in 5% of the titles or more/.test(w4 || ''), String(w4));
  // MUT-10: guards on connector words.
  const conOnly = rep('USB Fan Portable', 12).concat(rep('Desk Lamp', 8));
  ok('R-BRAND-3: a query of connector words only counts them for rule 2 ("usb hdmi lightning thunderbolt": 3 of 4 missing)',
    /^off-query-keywords: 3 of the 4 keywords \[hdmi, lightning, thunderbolt\]/.test(qr('usb hdmi lightning thunderbolt', conOnly).warning || ''));
  eq('R-BRAND-3: "typewriter" is not the connector word "type"', qr('typewriter ribbon', rep('Typewriter Ribbon Black', 10)).connectorKeywords, []);
  // MUT-01, MUT-02, CR-3: rank.mjs and the joined pool of a merge.
  const cases15 = fx.pocoCases.titles.slice(0, 15);
  const pool = realMice.concat(cases15);
  const poolQ = 'wired mouse | poco f7 ultra wallet case';
  ok('R-BRAND-3: (the check this guards) the joined pool of 326 mice and 15 POCO cases fires off-query-keywords', /^off-query-keywords/.test(qr(poolQ, pool).warning || ''));
  const items = pool.map((t, i) => ({ id: 'j' + i, title: t, rating: 4.8, sold: 500, soldRaw: '500+' }));
  const merged = (parts, source = 'merged') => ({ source, query: poolQ, parts, items, warnings: [] });
  const rk = (p) => rank(p, ['--mode', 'shortlist']).warnings.filter((w) => /^off-query/.test(w));
  eq('R-BRAND-3: rank.mjs drops that pool warning on a merge of two queries (F1)', rk(merged([{ query: 'wired mouse' }, { query: 'poco f7 ultra wallet case' }])), []);
  ok('R-BRAND-3: a payload with parts but not a merge keeps it', rk(merged([{ query: 'wired mouse' }, { query: 'poco f7 ultra wallet case' }], 'harvest-paged')).some((w) => /^off-query-keywords/.test(w)));
  const ph = fx.pocoPhones.titles.map((t, i) => ({ id: 'p' + i, title: t, rating: 4.8, sold: 500, soldRaw: '500+' }));
  const oneStream = { source: 'merged', query: fx.pocoPhones.query, items: ph, warnings: [],
    parts: [{ query: 'Poco F7 Ultra Wallet Case' }, { query: 'poco  f7 ultra wallet case' }] };
  ok('R-BRAND-3: one query written in two cases is one stream: rank.mjs keeps its off-query-keywords (CR-3)', rk(oneStream).some((w) => /^off-query-keywords/.test(w)));
  const wire = JSON.parse(SRC('fixtures/real-titles-2026-10-17.json')).craftWire.titles;
  const offPool = wire.concat(fx.iemCables.titles).map((t, i) => ({ id: 'o' + i, title: t, rating: 4.8, sold: 500, soldRaw: '500+' }));
  ok('R-BRAND-3: on a merge of two queries the share rule still reaches the ranking (craft wire + cables)',
    rk({ source: 'merged', query: 'wired usb mouse | type c iem', items: offPool, warnings: [], parts: [{ query: 'wired usb mouse' }, { query: 'type c iem' }] })
      .some((w) => /^off-query-results/.test(w)));
  // Survivors of the mutation run after the second review (2026-10-20).
  const mid = rep('Type C Cable', 8).concat(rep('Alpha Gadget', 2), rep('Bravo Gadget', 2), rep('Other Thing', 8));
  eq('R-BRAND-3: "type" in 40% of the titles does not carry the share: no off-query-connector', [qr('type c alpha bravo', mid).share, qr('type c alpha bravo', mid).warning], [0.6, null]);
  eq('R-BRAND-3: "usb c dongle" over titles that say only "Hub" raises nothing (hub is in the dongle class)', qr('usb c dongle', rep('USB C Hub 7 in 1', 10)).warning, null);
  ok('R-BRAND-3: one spec word and one plain word is not a spec-only query ("type c 2m hifi" over cables warns)',
    /^off-query-connector/.test(qr('type c 2m hifi', rep('Type C Cable Fast Charging', 10)).warning || ''));
  eq('R-BRAND-3: "grayhound" over "Grey Hound" titles: the UK form of a title join', qr('grayhound', rep('Grey Hound Statue', 10)).share, 1);
  eq('R-BRAND-3: "adaptor" over "Adapter" titles is on-query for the share rule (the UK map, not the goods table)', qr('adaptor', rep('Power Adapter 12V', 10)).share, 1);
  ok('R-BRAND-3: the connector text names only the connector word that carried the share', /matched on the connector word \[usb\], and every/.test(qr('usb hdmi widget', rep('USB Cable Fast', 10)).warning || ''),
    String(qr('usb hdmi widget', rep('USB Cable Fast', 10)).warning).slice(0, 90));
  // The limits the second review measured, pinned so a change sees them.
  eq('R-BRAND-3: known miss: the real POCO phones lack only 2 words for "poco wallet case" and "poco f7 case" (R1-MH1-F4)',
    [qr('poco wallet case', fx.pocoPhones.titles).warning, qr('poco f7 case', fx.pocoPhones.titles).warning], [null, null]);
  eq('R-BRAND-3: known miss: "lightning earphones" over real USB-C earphones (the connector word is in no title, CRIT2-1)',
    qr('lightning earphones', fx.typeCEarphones.titles).warning, null);
  ok('R-BRAND-3: known cost: "usb c 3 meter" over the real "usb c 3m" page warns (titles write "3M", FA2-6)',
    /^off-query-connector/.test(qr('usb c 3 meter', live.usbC3m.titles).warning || ''));
  // The inlined copy agrees on every input above.
  const blk = harvestText.match(/\/\* @shared:queryRelevance:start \*\/([\s\S]*?)\/\* @shared:queryRelevance:end \*\//);
  const inl = new Function(`${blk[1]}; return queryRelevance;`)();
  const cases = [['usb alpha bravo charlie delta', noUsb], ['typec iem', rep('TypeC Cable', 10)], ['organiser', rep('Organisers', 10)],
    ['aluminium jewellery colour wire', us], ['oxyled fridge magnet light motion', rep('Magnetic Light', 10)], ['usb c lead', live.usbC3m.titles],
    ['type c earpods', fx.typeCEarphones.titles], ['usb c 2m', fx.iemCables.titles], ['type c 2m', mixPage(6)], ['alpha beta gamma delta', s2],
    ['type c widget', s1], ['usb ' + fx.pocoPhones.query, fx.pocoPhones.titles], [poolQ, pool], ['usb hdmi lightning thunderbolt', conOnly]];
  eq('R-BRAND-3: harvest.js queryRelevance agrees with lib.mjs on all of them', cases.filter(([q, ts]) => JSON.stringify(inl(q, ts)) !== JSON.stringify(qr(q, ts))).length, 0);
});

// ---------------------------------------------- the whole suite on dist/
/* The operator pastes dist/*.min.js, so the suite runs again on them: every
 * scenario above, not a handful (review, 2026-10-18: only 4 assertions
 * touched dist, so a dist copy could change behaviour with a green suite). */
if (!DIST) {
  console.log('\nthe whole suite again, on the dist/*.min.js copies');
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, AEF_DIST: '1' }, encoding: 'utf8', maxBuffer: 1 << 26 });
  const last = (child.stdout || '').trim().split('\n').pop();
  ok('every assertion passes on dist/ too', child.status === 0 && /^PASSED/.test(last), last + ' ' + (child.stderr || '').slice(0, 200));
  // The README states the exact count (this check included).
  const readmeN = Number((SRC('../README.md').match(/Test suite: (\d+) assertions/) || [])[1]);
  const total = pass + fails.length + 1;
  ok(`README.md states the real number of assertions (${total})`, readmeN === total, `README says ${readmeN}`);
}

// -------------------------------------------------------------------------
console.log(`\n${fails.length ? 'FAILED' : 'PASSED'} — ${pass} assertions ok, ${fails.length} failed`);
if (fails.length) { fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
