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
eq('bidi marks stripped', parseSold('‎10,000+‏'), 10000);
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
eq('bidi marks around "100K+"', parseSold('‎100K+‏'), 100000);
eq('a bare "K" is not a number', parseSold('K'), null);
eq('"K100" is not a number', parseSold('K100'), null);
eq('the bucket below is unchanged: "50,000+"', parseSold('50,000+'), 50000);
ok('"100K+" clears the shortlist evidence floor', parseSold('100K+') >= 100);

// --------------------------------- browser-side files: parseSold drift guard
// extract.js AND harvest.js each inline a copy because they run in the browser
// and cannot import lib.mjs. Both copies must agree with lib.mjs.
console.log('\nbrowser files inline parseSold — assert no copy has drifted');
const SHARED_FIXTURES = ['10,000+', '4.000+', '3.000+', '456', '1,000+', '900+', '1,234,567',
  '', 'abc', '1.5', '10,00', '‎10,000+‏', '10, 000 +',
  '100K+', '100k', '1.2K', '1,2K', '12.5K+', '1.1K', '2M+', '‎100K+‏', 'K', 'K100', '50,000+'];
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
eq('clean strips bidi + collapses ws', clean('‎a   b‏'), 'a b');

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
  eq('drop reasons tallied', r.droppedReasons, { 'no rating': 1, 'rating<4': 1, 'evidence<10': 1 });
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
const harvestSrc = readFileSync(join(HERE, 'harvest.js'), 'utf8');
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
  const listingSrc = readFileSync(join(HERE, 'listing.js'), 'utf8');

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
  const src = readFileSync(join(HERE, 'harvest.js'), 'utf8');
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
  const src = readFileSync(join(HERE, 'harvest.js'), 'utf8');
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
    ok(`chunk ${i} is wrapped in markers`, new RegExp(`^AEPAYLOAD ${i}/${info.count} START\\n[\\s\\S]*\\nAEPAYLOAD END$`).test(pre.textContent));
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

  const src = readFileSync(join(HERE, 'harvest.js'), 'utf8');
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
    const winHeld = { document: doc };
    new Function('window', 'fetch', src)(winHeld, (url) => url.startsWith('http://127.0.0.1:') ? new Promise(() => {}) : Promise.resolve(reply(makePage({ items: [makeItem('h1')], finished: true }))));
    winHeld.__aeHarvest.start({ query: 'wire brush set' });
    await winHeld.__aeHarvest.step(1);
    const msg2 = await winHeld.__aeHarvest.send(9999, { timeoutMs: 50 });
    ok('a held fetch falls back to a form POST', /^form-posted /.test(msg2), msg2);
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
    const winHidden = { document: hiddenDoc };
    let loopbackCalls = 0;
    new Function('window', 'fetch', src)(winHidden, (url) => {
      if (url.startsWith('http://127.0.0.1:')) { loopbackCalls++; return Promise.resolve({ status: 200, text: async () => 'saved /tmp/y.json' }); }
      return Promise.resolve(reply(makePage({ items: [makeItem('h3')] })));
    });
    winHidden.__aeHarvest.start({ query: 'wire brush set' });
    await winHidden.__aeHarvest.step(1);
    const msg4 = await winHidden.__aeHarvest.send(9999);
    eq('a hidden tab never calls the loopback fetch', loopbackCalls, 0);
    ok('a hidden tab posts the form straight away', /^form-posted /.test(msg4) && forms.length === 2, msg4);
    ok('the reply says why the fetch was skipped', /tab hidden: fetch skipped/.test(msg4), msg4);
    ok('the reply points at the receiver output, not get_page_text',
      /receiver prints the saved path in its own output/.test(msg4) && /get_page_text hangs/.test(msg4), msg4);
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
  const src = readFileSync(join(HERE, 'harvest.js'), 'utf8');
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
  const extractSrc = readFileSync(join(HERE, 'extract.js'), 'utf8');
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

// -------------------------------------------------------------------------
console.log(`\n${fails.length ? 'FAILED' : 'PASSED'} — ${pass} assertions ok, ${fails.length} failed`);
if (fails.length) { fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
