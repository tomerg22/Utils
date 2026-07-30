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
import { parseSold, median, clean } from './lib.mjs';

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

// ------------------------------------------------- extract.js drift guard
console.log('\nextract.js inlines parseSold — assert the copy has not drifted');
const src = readFileSync(join(HERE, 'extract.js'), 'utf8');
const block = src.match(/\/\* @shared:parseSold:start \*\/([\s\S]*?)\/\* @shared:parseSold:end \*\//);
ok('extract.js exposes the @shared:parseSold block', !!block);
if (block) {
  const inlined = new Function(`${block[1]}; return parseSold;`)();
  const fixtures = ['10,000+', '4.000+', '3.000+', '456', '1,000+', '900+', '1,234,567',
    '', 'abc', '1.5', '10,00', '‎10,000+‏', '10, 000 +'];
  const drift = fixtures.filter((f) => JSON.stringify(inlined(f)) !== JSON.stringify(parseSold(f)));
  ok('inlined copy agrees with lib.mjs on every fixture', drift.length === 0, `drifted on ${JSON.stringify(drift)}`);
  eq('inlined copy handles dot-thousands', inlined('4.000+'), 4000);
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

// -------------------------------------------------------------------------
console.log(`\n${fails.length ? 'FAILED' : 'PASSED'} — ${pass} assertions ok, ${fails.length} failed`);
if (fails.length) { fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
