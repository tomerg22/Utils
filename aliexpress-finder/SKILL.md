---
name: aliexpress-finder
description: Find the best AliExpress products for a described item. Ranks candidates by user rating, review count and units sold using Bayesian shrinkage, then checks brand reputation and counterfeit plausibility. Use when the user asks to find, compare, or shop for a product on AliExpress.
---

# AliExpress product finder

Take a free-text product description, return the top 4 listings with evidence.

Runs on the in-app browser (`mcp__Claude_Browser__*`). **Local Claude Code only** —
does not work in Cowork, cloud sessions, or scheduled routines, because personal
skills and the browser tools are both absent there.

## Before you start

Read this whole file. The gotchas below are verified against the live site
(last full run 2026-07-30); skipping them produces silently empty or wrong results.

Sanity-check the tooling whenever you change it:

```bash
node ~/.claude/skills/aliexpress-finder/scripts/test.mjs
```

## Step 1 — Build the search URL

Reduce the description to 2-4 English keywords. English queries work fine on the
Hebrew storefront and return Hebrew titles with ILS prices.

```
https://he.aliexpress.com/w/wholesale-<kebab-keywords>.html?SortType=total_tranpro_desc
```

`SortType=total_tranpro_desc` sorts by orders. **Always use it.** On default sort
the top results included "Lenovo 225W 500000mAh" at ₪48 — a physically impossible
capacity, i.e. a counterfeit. Sorting by orders removed those entirely.

**Prefer a specific multi-word query.** `wholesale-milk-frother` returned 13 DOM
cards of which 9 were junk; `wholesale-electric-milk-frother-handheld` returned
**60 usable records** for the same category. If a query yields a thin pool, run a
second, more specific one and merge — `rank.mjs` dedupes by id.

**`&page=2` is not more of the same.** On a real run, page 2 of a frother search
returned an eye cream, a makeup brush set, a wrinkle stick and an espresso
machine — recommendations, not results. Always eyeball page-2+ titles for
category drift before merging, and use `--require` (step 4).

## Step 2 — Open the browser

If no browser pane is open, `preview_start` with the URL. Otherwise `navigate`.
`preview_start` is required first — `navigate` alone errors with "No preview is open".

### If you hit the captcha wall

AliExpress may serve an anti-bot interstitial: title `Captcha Interception`, URL
path `/_____tmd_____/punish?x5secdata=…`, body "Sorry, we have detected unusual
traffic from your network" with a **"Please slide to verify"** slider.

- **Do not solve or bypass it.** Completing bot-detection challenges is off-limits.
- Ask the user to drag the slider in the browser pane themselves.
- **Then do nothing but read.** Do NOT `navigate` or `navigate --force` while
  waiting or right after — a fresh request returns a fresh `x5secdata` token and
  re-blocks the tab, discarding the state the user just cleared. Once solved the
  punish page redirects itself to the target URL.
- Each attempt returning a *different* `x5secdata` confirms genuine server-side
  rejection rather than a cached page.
- `extract.js` reports `blocked: true` when it sees this page, so an empty result
  is never mistaken for "no products found".

## Step 3 — Extract

Pass the **entire contents** of `scripts/extract.js` as the `text` argument of
`javascript_tool`. It returns a JSON string and reports which source it used.

It reads two sources, in order:

1. **`window._dida_config_._init_data_`** — the payload the page rendered from,
   holding ~60 fully-structured records. **This is the good path.** It does not
   depend on anything being painted.
2. **DOM cards** — fallback only.

**Why source 1 exists:** with the Browser pane hidden, the results container
renders at `clientHeight: 0`, `IntersectionObserver` never fires, lazy loading
stalls, and the DOM yields ~13 cards while the embedded JSON on the *same page*
holds 60. Scrolling cannot fix this; the pane must be visible for DOM extraction
to work at all.

`__INIT_DATA__` really is undefined and `runParams` really is empty, whatever
scraping blogs claim — but `_dida_config_._init_data_` is not. The known path is
`data.data.root.fields.mods.itemList.content`; the extractor falls back to a
bounded deep walk for any array of objects with a `productId`, so a path change
degrades to slower rather than broken.

If using the DOM fallback, check readiness before extracting — re-check until
`cards` stops rising:

```js
(() => ({ cards: document.querySelectorAll('a[href*="/item/"]').length,
          bodyLen: (document.body.textContent||'').length }))()
```

Repeat steps 2-3 per query/page and keep all payloads.

## Step 4 — Shortlist

```bash
node ~/.claude/skills/aliexpress-finder/scripts/rank.mjs --mode shortlist --top 10 < harvest.json
```

Accepts one payload, an array of payloads, or a bare item array; dedupes by id.

Drop off-category items with a title regex:

```bash
... --require 'מקציף|קצף'
```

The no-rating filter removes AliExpress's SEO keyword-stuffing links (titles like
"milk frother containeraliexpress milk frotherautomatic milk frother…", all
fields null). Expect roughly 9 of 13 DOM cards to be junk — the `_init_data_`
path avoids most of them.

Expect **ties**. Sold saturates at "10,000+", so top candidates score
identically. That is exactly why step 5 exists.

## Step 5 — Fetch exact review counts (mandatory)

Sold counts are bucketed ("1,000+", "5,000+") and saturate at "10,000+". The only
fine-grained signal is the exact review count, in JSON-LD on the detail page.

For each shortlisted item, navigate to its URL and run:

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
by matching the title against the category's brand filter vocabulary (embedded in
the search page as `"text":"<Brand>"` entries) plus obvious names in the title.

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

**If the pool mixes product classes, split it and rank separately.** A handheld
frothing wand and an automatic heating carafe both match "milk frother" but are
not substitutes; ranking them together produces a top-4 the user cannot act on.
Ask which class they want, or present both.

## Step 8 — Report

Table of the 4: title, detail price ₪, rating, review count, sold, brand verdict,
link. Then, briefly:

- why each won (cite the actual numbers)
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
That is correct, not a bug.

## Files

| File | Role |
|------|------|
| `scripts/extract.js` | Browser-side extractor. `_init_data_` first, DOM fallback, reports `source` and `blocked`. |
| `scripts/rank.mjs` | Ranker. Bayesian shrinkage, log volume, neutral brand default, `--require` filter. |
| `scripts/lib.mjs` | Pure helpers (`parseSold`, `median`, `clean`) shared by ranker and tests. |
| `scripts/test.mjs` | 52-assertion suite incl. regression guards for all three 2026-07-30 defects. |

`extract.js` runs in the browser and cannot import `lib.mjs`, so it inlines
`parseSold` between `@shared:parseSold` markers. `test.mjs` pulls that copy out
and asserts it matches `lib.mjs` on every fixture — **keep both in sync, the
test will catch you if you don't.**

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
the ToS. This is fine for occasional personal shopping. Do not build bulk
harvesting on it.
