---
name: aliexpress-finder
description: Take a free-text product description and return the top listings with evidence, by paging AliExpress search and ranking on shrunk ratings + review counts.
---

# AliExpress product finder

Take a free-text product description, return the top 4 listings with evidence.

Runs on the in-app browser (`mcp__Claude_Browser__*`). **Local Claude Code only** —
does not work in Cowork, cloud sessions, or scheduled routines, because personal
skills and the browser tools are both absent there.

## Before you start

Read this whole file. The gotchas below are verified against the live site
(last full run 2026-08-21); skipping them produces silently empty or wrong results.

Sanity-check the tooling whenever you change it:

```bash
node ~/.claude/skills/aliexpress-finder/scripts/test.mjs
```

## The rule that matters most

**If a human-verification wall appears, STOP and tell the user in that turn, as
the headline.** Do not keep working and mention it later in a summary. See
step 2. This is not a nicety — it happened, and it is why step 3 changed.

## Step 1 — Build the search URL

Reduce the description to 2-4 English keywords. English queries work fine on the
Hebrew storefront and return Hebrew titles with ILS prices.

```
https://he.aliexpress.com/w/wholesale-<kebab-keywords>.html?SortType=total_tranpro_desc&selectedSwitches=filterCode%3A4StarRating
```

Two parameters, both mandatory.

`SortType=total_tranpro_desc` sorts by orders. On default sort the top results
included "Lenovo 225W 500000mAh" at ₪48 — a physically impossible capacity, i.e.
a counterfeit. Sorting by orders removed those entirely.

`selectedSwitches=filterCode%3A4StarRating` is the highest-value single
parameter and it is easy to miss. Measured on `wire brush set`: it cut the pool
from 18,655 to 7,206, and — the point — it took the share of returned rows that
actually carry a rating from **13 of 60** at an unfiltered page 20 to **60 of
60**. Across a full 20-page harvest, 1,166 of 1,166 rows were rated. `rank.mjs`
discards every unrated item and everything below 4.0 anyway, so this filter
removes nothing it would have kept. It roughly triples usable rows per request,
and requests — not results — are the scarce resource here (see step 2).

**BROADEN the query, do not narrow it.** This file used to say that a thin pool
means running "a second, more specific one". That advice is deleted because it
caused a real miss: narrowing restricts results to items whose titles match
wording you guessed. A 7-inch hand wire brush at 4.9 from 123 reviews was absent
from every specific query tried, yet sits at **page 6 of a plain `wire brush
set` search**. Search broad, page deep (step 3), separate classes and filter
locally (step 4).

### Other URL levers, from the `searchRefineFilters` module

The refine module on any search page exposes the catalogue's own filter
vocabulary. Read it when you need to narrow by a real attribute rather than by
guessed words:

```js
(() => window._dida_config_._init_data_.data.data.root.fields.mods
  .searchRefineFilters.content.map(g => ({ title: g.title, paramName: g.paramName,
    attributeId: g.attributeId,
    opts: (g.content||[]).map(o => ({ text: o.text, value: o.selectedValue })) })))()
```

| Lever | URL param | Value form |
|---|---|---|
| Rating 4★+ | `selectedSwitches` | `filterCode:4StarRating` |
| Free shipping / sale / Choice | `selectedSwitches` | `filterCode:freeshipping`, `:bigsale`, `:choice_atm` |
| Any attribute (colour, material, brand) | `attr` | `<attributeId>-<valueId>`, e.g. `11795-4362329` |
| Ship from | `shpf_co` | `IL`, `TR`, `CN` |
| Price range | `pr` | range string |

Multiple `selectedSwitches` values join with `,`. Pass extras through
`__aeHarvest.start({ extra: '&shpf_co=CN' })`.

## Step 2 — Open the browser, and respect the wall

If no browser pane is open, `preview_start` with the URL. Otherwise `navigate`.
`preview_start` is required first — `navigate` alone errors with "No preview is open".

### The anti-bot wall — detect it, alert, and stop

AliExpress serves an interstitial after sustained automated requests: title
`Captcha Interception`, URL path `/_____tmd_____/punish?x5secdata=…`, body
"Sorry, we have detected unusual traffic from your network" with a **"Please
slide to verify"** slider.

- **Do not solve or bypass it.** Completing bot-detection challenges is off-limits.
- **Tell the user immediately, in that turn, at the top of the reply**, and keep
  saying it until they confirm it is cleared. Detecting it and reporting it at
  the end of a long write-up is the same as not detecting it — that is exactly
  what went wrong on 2026-08-21.
- Ask the user to drag the slider in the browser pane themselves.
- **Then do nothing but read.** Do NOT `navigate` or `navigate --force` while
  waiting or right after — a fresh request returns a fresh `x5secdata` token and
  re-blocks the tab, discarding the state the user just cleared.
- Each attempt returning a *different* `x5secdata` confirms genuine server-side
  rejection rather than a cached page.
- When they say it is cleared, verify with ONE cheap request and report what it
  returned before resuming.

**Budget your requests.** The wall tripped after roughly 50-60 rapid fetches in
one session. That is a measured count, not a documented limit, so treat it as an
order of magnitude. A normal task fits comfortably: one harvest of ~20 pages
plus ~10 detail pages is ~30 requests. Two harvests plus detail pages is near
the edge. Three is over it.

**Every code path that can fetch MUST carry block detection with it.** A blocked
response has no payload, so a naive parser returns null and the caller logs
"parse failed" — which reads like a bug, not a wall. `harvest.js` checks
`blockedBy()` *before* parsing and sets `stop: 'blocked'`; `extract.js` sets
`blocked: true`. Never add a fetch path without one of them.

## Step 3 — Harvest (paged)

Pass the **entire contents** of `scripts/harvest.js` as the `text` argument of
`javascript_tool`. It installs `window.__aeHarvest` and returns a status string.

```js
__aeHarvest.start({ query: 'wire brush set' })  // returns the plan + URL
__aeHarvest.step(8)                             // repeat until .done
__aeHarvest.payload()                           // JSON string for rank.mjs
```

`step(n)` is resumable because `javascript_tool` dies at 30s, which is about
8-12 fetches. Call it repeatedly until `done: true`. It stops on `exhausted`,
`page-cap`, `request-budget`, `blocked`, `fetch-error` or `parse-error` — and
**`blocked` means go to step 2 and alert the user.**

Defaults are `maxPages: 20`, `maxRequests: 24`, `fourStar: true`.

**Read until the stream runs dry, then report which happened.** Do not assume a
fixed depth — it varies enormously by query and is not even stable between runs:

| Query | Served |
|---|---|
| `wire brush set` (4★) | 1,166 unique over 20 pages, still going at the cap |
| `travel duffel bag` (4★) | 473 over 8 pages, 98% on-category, still going |
| `balance board roller` (4★) | dry at page 5 — and page 7 an hour earlier |

**`pageInfo.totalResults` is not a denominator.** The balance-board query
claimed **160,188** results and served nothing past page 4. Never report
coverage as a percentage of it. Report `coverage.verdict`:
`exhausted-all-results` or `truncated`.

**Paging works — the old warning was wrong.** This file used to claim `&page=2`
returns recommendations rather than results. Measured: pages 1-12 of `wire brush
set` gave 709 unique items with 59-60 fresh on *every* page, zero duplicates and
zero category drift. Drift is real but only **deep** and only **unfiltered** —
page 40 of an unfiltered brush search returns hair clips, and page 60 is the
hard ceiling. With the 4★ filter, on-category stayed 97-100% through page 20.

### Single-page fallback

`scripts/extract.js` still reads the **currently loaded** page and is the right
tool when you only need what is on screen, or when `harvest.js` cannot fetch. It
reads `window._dida_config_._init_data_` first (~60 structured records) and
falls back to DOM cards.

With the Browser pane hidden the results container renders at `clientHeight: 0`,
`IntersectionObserver` never fires, lazy loading stalls, and the DOM yields ~13
cards while the embedded JSON on the *same page* holds 60. Scrolling cannot fix
this. `__INIT_DATA__` really is undefined and `runParams` really is empty,
whatever scraping blogs claim — but `_dida_config_._init_data_` is not.

### Getting a large payload out of the browser

A full harvest is ~90KB per 400 items and will exceed the tool-result limit.
That is fine: the harness saves the oversized result to a file and prints the
path. Slice `payload()` into parts, then decode locally — the saved text is
**double-encoded** (a JSON file whose `text` field holds a JSON string):

```js
const raw = JSON.parse(fs.readFileSync(savedPath, 'utf8'));
const t = raw.map(x => x.text).join('');
const first = t.indexOf('"');
for (let end = t.lastIndexOf('"'); end > first; end = t.lastIndexOf('"', end - 1)) {
  try { obj = JSON.parse(JSON.parse(t.slice(first, end + 1))); break; } catch (e) {}
}
```

## Step 4 — Shortlist, and split the classes

```bash
node ~/.claude/skills/aliexpress-finder/scripts/rank.mjs --mode shortlist --top 10 < harvest.json
```

Accepts one payload, an array of payloads, or a bare item array; dedupes by id.
The `harvest.js` envelope is consumed directly.

**Class separation is mandatory once the pool is large, not optional.** With 60
items a mixed pool was survivable. With 1,166 it is not: a `wire brush set`
harvest contains hand brushes, drill-mounted wheel brushes, rotary/Dremel sets,
bottle brushes, PCB anti-static brushes and gas-hob brushes. They are not
substitutes. Filter to the class the user actually asked for:

```bash
... --require 'ידית|יד |אינץ' 
```

In the measured run, a hand-brush `--require` cut 1,166 to 187 and the ranking
became answerable. Ask which class the user wants, or present both.

The no-rating filter removes AliExpress's SEO keyword-stuffing links (titles
like "milk frother containeraliexpress milk frother…", all fields null). The 4★
URL filter from step 1 already removes nearly all of these upstream.

Expect **ties**. Sold saturates at "10,000+", so top candidates score
identically. That is exactly why step 5 exists.

## Step 5 — Fetch exact review counts (mandatory)

Sold counts are bucketed ("1,000+", "5,000+") and saturate at "10,000+". The
only fine-grained signal is the exact review count, in JSON-LD on the detail page.

**Do not sample the shortlist by score alone.** This is a real defect found on
2026-08-21 and it is the reason a good item can still be missed after paging
fixed recall. Shortlist mode ranks on `sold`, so an item with 700 sold ranks
below dozens with 10,000+ — even when its review evidence is far stronger. The
7-inch hand brush (4.9, **123 reviews**, 700 sold) ranked **32 of 147** inside
its own class, invisible to a top-10-by-score sample, while a competitor with
10,000 sold and 28 reviews sat at the top. Review-per-sale is a signal the skill
already believes in — it flags `few-reviews-for-sales` below 2% — but it cannot
compute it until this step.

So spend the step-5 budget on a **spread**, using the flag rather than by hand:

```bash
node .../rank.mjs --mode shortlist --top 10 --spread 4 < harvest.json
```

`--spread K` reserves K of the K+N slots for a stratified sample across sold
tiers (`10000+`, `5000+`, `3000+`, `1000+`, `500+`, `100+`), taking the
best-scoring candidate from each starting at the **lowest** — the head already
covers the saturated top. Picks are labelled `pick: "spread"` and flagged
`spread-pick`, and the output reports `spreadTiers`. In `final` mode the tiers
follow `reviews` instead of `sold`. Without the flag, behaviour is byte-for-byte
what it was.

Measured on the real 187-item hand-brush pool: plain `--top 10` returned six
listings at 10,000+ sold and nothing below 2,000. `--top 10 --spread 4` reached
the `100+`, `500+`, `1000+` and `3000+` tiers and surfaced a 5.0-at-466-sold and
a 4.9-at-900-sold listing that top-by-score never sees.

**Know its limit — this is not a homing beacon.** Stratification samples the
evidence range; it cannot single out one listing. The 7-inch hand brush above
sits **6th inside a 500+ tier holding 27 items**, and `--spread 16` still does
not reach it, because on search-page evidence alone it is genuinely
indistinguishable from five near-identical tier-mates. Nothing but an actual
review count separates them, and that costs one request each. If the user wants
a specific listing evaluated, the honest lever is a larger `--top` with more
step-5 fetches, not a cleverer sort. Say so rather than implying the tool found
the best item when it sampled a tier.

For each selected item, navigate to its URL and run:

```js
(() => {
  const el = document.querySelector('script[type="application/ld+json"]');
  if (!el) return JSON.stringify({error:'not loaded yet'});
  const arr = JSON.parse(el.textContent);
  const p = (Array.isArray(arr)?arr:[arr]).find(x => x['@type']==='Product');
  const body = (document.body.textContent||'').replace(/\s+/g,' ');
  return JSON.stringify({ id:(location.pathname.match(/(\d+)\.html/)||[])[1],
    rating:p?.aggregateRating?Number(p.aggregateRating.ratingValue):null,
    reviews:p?.aggregateRating?Number(p.aggregateRating.reviewCount):null,
    price:p?.offers?Number(p.offers.price):null,
    sold:(body.match(/([\d.,]+\+?)\s*נמכר/)||[])[1]||null });
})()
```

JSON-LD carries rating, reviewCount, price and currency — but **not** sold count
and **not** brand. Sold comes from the body text; brand comes from step 6.

**Detail price often differs from search price** — the grid shows a
cheapest-variant or promo figure. Observed gaps in one run: ₪22.30 → ₪37.44
(+68%), ₪5.30 → ₪12.25, ₪11.30 → ₪21.82. **Always report the detail-page price**
and call out any large gap; it is the number the user actually pays.

## Step 6 — Brand: plausibility first, reputation second

Most listings are "No Brand", and there is no reliable brand field. Detect brand
by matching the title against the category's brand filter vocabulary (the
`מותג` group in `searchRefineFilters`, step 1) plus obvious names in the title.

Do **not** read brand off the detail page spec row — that regex catches badges
like "מוביל ב-AliExpress" (a ranking badge, not a brand).

**Brandless → skip this item entirely.** Set no `brandScore`; `rank.mjs` scores
it at the neutral `--brand-default` (0.5) rather than punishing it.

**Branded → research each distinct brand** for both:

1. **Plausibility.** Are these specs and this price credible for this brand? A
   real brand name on AliExpress does not mean a genuine product. Check claimed
   capacity/wattage against the brand's actual product line, and the price
   against real retail. *Worked example:* HiBREW M1A listed ₪133.56 ≈ €33, and
   EU retail is €39 with matching 450W specs — just under retail, which is
   normal for direct-from-China and **not** the impossible-price fake pattern.
2. **Reputation.** What do independent reviews say about the brand here?

Produce `brandScore` 0..1 and a one-line reason. Score a counterfeit-implausible
listing near 0 so it cannot be promoted. Score an unknown-but-not-impersonating
house brand mid-low (~0.35) — unsupported is not the same as fraudulent.

Use parallel subagents (one per brand) when the environment allows it; otherwise
do the research inline with web search. Either satisfies this step.

**This is the trap the whole step exists for:** a naive "prefer known brands"
rule promotes counterfeits, because the fakes wear the strongest brand names.

## Step 7 — Final rank

Add `reviews` and any `brandScore` to each finalist, then:

```bash
node ~/.claude/skills/aliexpress-finder/scripts/rank.mjs --mode final --top 4 < finalists.json
```

When any item carries a `brandScore`, weights are 0.60 quality / 0.25 volume /
0.15 brand, and items without one use the neutral `--brand-default` (0.5), are
flagged `brand-unresearched`, and are counted in `brandDefaulted`. When no item
carries one, brand weight is redistributed to 0 so nothing is scored on absent
data.

## Step 8 — Report

Table of the 4: title, detail price ₪, rating, review count, sold, brand verdict,
link. Then, briefly:

- why each won (cite the actual numbers)
- **coverage, honestly**: whether the harvest was `exhausted-all-results` or
  `truncated`, how many unique items and how many pages. Never a percentage of
  `totalResults`.
- which product class was ranked, and what was excluded
- that step-5 detail fetches were a spread (`--spread`), which tiers it reached,
  and that stratification samples the range rather than proving one winner
- any `flags` raised (`extreme-discount`, `price-outlier-low`, `sold-saturated`,
  `reviews-exceed-sold`, `few-reviews-for-sales`, `brand-unresearched`)
- any large search-vs-detail price gap
- anything dropped for a notable reason (off-category, SEO junk, thin evidence)

Say plainly that prices and stock are live and change constantly.

## Scoring, in one paragraph

Raw rating is not comparable: 5.0 from 3 reviews is weaker evidence than 4.8 from
5,000. Each rating is shrunk toward the pool mean, weighted by evidence
(`quality = (n·p + m·C)/(n + m)`). Volume is `log10` scaled so a saturated
"10,000+" cannot dominate. Verified in `test.mjs`: a planted 5.0-with-4-reviews
item ranks below a genuine 4.9-with-4,790-reviews item and is flagged
`few-reviews-for-sales`.

Note a real property of the math: when candidates share the same rating,
shrinkage moves them all equally and **review volume alone decides the order**.
That is correct, not a bug — but in `shortlist` mode the "volume" is bucketed
`sold`, which is why step 5 must sample a spread rather than the head.

## Files

| File | Role |
|------|------|
| `scripts/harvest.js` | **Primary.** Browser-side paged harvester: resumable, block-aware, reads until dry, reports `coverage.verdict`. |
| `scripts/extract.js` | Single-page extractor for the currently loaded page. `_init_data_` first, DOM fallback, reports `source` and `blocked`. |
| `scripts/rank.mjs` | Ranker. Bayesian shrinkage, log volume, neutral brand default, `--require` filter, `--spread` tier stratification. |
| `scripts/lib.mjs` | Pure helpers (`parseSold`, `median`, `clean`) shared by ranker and tests. |
| `scripts/test.mjs` | Assertion suite incl. regression guards for every defect below. |

`harvest.js` and `extract.js` run in the browser and cannot import `lib.mjs`, so
each inlines `parseSold` between `@shared:parseSold` markers. `test.mjs` pulls
**both** copies out and asserts they match `lib.mjs` on every fixture — keep all
three in sync, the test will catch you if you don't.

### Defects fixed 2026-08-21 (do not reintroduce)

1. **One page of 60 was the whole world.** Recall was a function of guessed
   wording. Fixed by `harvest.js`. The false "`&page=2` is not more of the same"
   claim that justified it has been deleted — it does not survive measurement.
2. **"Narrow further when the pool is thin."** Backwards. Broaden and page.
3. **A wall looked like a parse bug.** An ad-hoc fetch path bypassed
   `extract.js`, so the punish page produced a null parse logged as
   `carve-fail`, and the block was reported to the user only at the end of a
   long write-up. Both halves fixed: detection lives in every fetch path, and
   the alert is immediate (step 2).
4. **`totalResults` treated as a denominator.** It is an estimate and often
   fiction (160,188 claimed, 4 pages served). Report exhausted-vs-truncated.
5. **Step 5 sampled only the head of the shortlist**, so a strong-review /
   moderate-sold item could never earn its review count — a self-sealing
   failure, since the signal that would promote it only exists on a page the
   shortlist decides whether to fetch. Fixed by `rank.mjs --spread`.

### Defects fixed 2026-07-30 (do not reintroduce)

1. **Sold parsing.** The Hebrew storefront uses **both** `,` and `.` as the
   thousands separator — real values include `10,000+` *and* `4.000+`. Stripping
   only `,` turned `4.000+` into `4`, silently dropping a 4,000-sold listing
   below the evidence floor.
2. **Extraction ceiling.** DOM-only scraping capped at 13 cards when the pane was
   hidden; `_init_data_` gave 60 on the same page.
3. **Brand zeroing.** A missing `brandScore` was treated as `0`, so with
   identical evidence a counterfeit scored 0.838 against a brandless 0.835 — the
   ranker promoted the fake, inverting the whole purpose of step 6.

## Legal note — state this if the user asks about scale

AliExpress Terms of Use §3.2(a) prohibits systematic retrieval of site content to
compile a collection or database without written permission. robots.txt disallows
`/items/*`, `/search/*` and `/product/*`; the paths used here (`/w/wholesale-*.html`
and `/item/*.html`) are not in that disallow list, but robots.txt does not override
the ToS. This is fine for occasional personal shopping — one product search at a
time, a few dozen requests. The `maxRequests` default exists partly for this
reason. Do not build bulk harvesting on it, and do not run it unattended.
