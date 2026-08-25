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
import { parseSold, median, clean, wallVerdict } from './lib.mjs';

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

// --------------------------------- browser-side files: parseSold drift guard
// extract.js AND harvest.js each inline a copy because they run in the browser
// and cannot import lib.mjs. Both copies must agree with lib.mjs.
console.log('\nbrowser files inline parseSold — assert no copy has drifted');
const SHARED_FIXTURES = ['10,000+', '4.000+', '3.000+', '456', '1,000+', '900+', '1,234,567',
  '', 'abc', '1.5', '10,00', '‎10,000+‏', '10, 000 +'];
for (const file of ['extract.js', 'harvest.js']) {
  const src = readFileSync(join(HERE, file), 'utf8');
  const block = src.match(/\/\* @shared:parseSold:start \*\/([\s\S]*?)\/\* @shared:parseSold:end \*\//);
  ok(`${file} exposes the @shared:parseSold block`, !!block);
  if (!block) continue;
  const inlined = new Function(`${block[1]}; return parseSold;`)();
  const drift = SHARED_FIXTURES.filter((f) => JSON.stringify(inlined(f)) !== JSON.stringify(parseSold(f)));
  ok(`${file} copy agrees with lib.mjs on every fixture`, drift.length === 0, `drifted on ${JSON.stringify(drift)}`);
  eq(`${file} copy handles dot-thousands`, inlined('4.000+'), 4000);
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
  ok('slugifies the query into the wholesale path',
    plan.url.includes('/w/wholesale-wire-brush-set.html'), plan.url);
  ok('always sorts by orders', plan.url.includes('SortType=total_tranpro_desc'));
  ok('applies the 4-star filter by default',
    plan.url.includes('selectedSwitches=filterCode%3A4StarRating'), plan.url);
  const plan2 = H.start({ query: 'a b', fourStar: false });
  ok('fourStar:false omits the rating filter',
    !plan2.url.includes('4StarRating'), plan2.url);
  const plan3 = H.start({ query: 'a b', extra: '&shpf_co=CN' });
  ok('extra params are appended', plan3.url.includes('&shpf_co=CN'));
  let threw = false;
  try { H.start({ query: '   ' }); } catch (e) { threw = true; }
  ok('empty query throws rather than fetching a broken URL', threw);
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
}
{
  // `finished: true` on a page that still HAS items must still stop.
  const H = loadHarvest(async (url) => {
    const p = Number(new URL(url).searchParams.get('page'));
    return reply(makePage({ items: [makeItem('x' + p)], finished: p >= 2, page: p }));
  });
  H.start({ query: 'wire brush set' });
  const st = await H.step(9);
  eq('honours finished:true even with items present', st.stop, 'exhausted');
  eq('kept both pages of items', st.unique, 2);
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
    closest: () => null, click() { (props.onClick || (() => {}))(); },
  });
  const mkRoot = (els) => ({ querySelectorAll: () => els });

  const runListing = ({ href, bodyText, els, shadowEls = [], html = '', ldCount = null }) => {
    const host = mkEl('DIV', { shadow: mkRoot(shadowEls) });
    const all = [...els, host];
    const document = {
      body: { scrollHeight: 5000, innerText: bodyText },
      documentElement: { outerHTML: html },
      // ldCount lets a test express "big page, zero JSON-LD" — the shape of
      // the quiet wall that walked through the old boolean check.
      querySelectorAll: (sel) =>
        (ldCount !== null && /ld\+json/.test(sel || '')) ? new Array(ldCount) : all,
    };
    const sandbox = {
      window: { scrollTo() {} }, document, location: { href },
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
  const blockedRes = blockedApi.read();
  ok('listing.js reports a wall as blocked, not as empty data', blockedRes.blocked === true);
  ok('blocked result tells the operator to stop this turn',
    /STOP and tell the user/.test(blockedRes.note || ''), blockedRes.note);

  // (b)+(c) text and images in one call, image hidden behind a shadow root
  const shadowImg = mkEl('IMG', {
    src: 'https://ae-pic-a1.aliexpress-media.com/kf/Sbig.jpg', nw: 800, nh: 800,
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
  const res = api.read();
  ok('image behind a shadow root IS found (bare querySelectorAll returns 1)',
    res.gallery.some((u) => /Sbig\.jpg/.test(u)), JSON.stringify(res.gallery));
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
}

// -------------------------------------------------------------------------
console.log(`\n${fails.length ? 'FAILED' : 'PASSED'} — ${pass} assertions ok, ${fails.length} failed`);
if (fails.length) { fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
