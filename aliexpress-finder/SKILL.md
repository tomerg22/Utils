---
name: aliexpress-finder
description: Take a free-text product description and return the top listings with evidence, by paging AliExpress search and ranking on shrunk ratings + review counts.
---

# AliExpress product finder

Take a free-text product description, return the top 4 listings with evidence.

Runs on the **Chrome connector** (`mcp__claude-in-chrome__*`, the user's own
signed-in browser) when one is connected, and on the in-app browser
(`mcp__Claude_Browser__*`) otherwise — step 0 decides. **Local Claude Code
only** — does not work in Cowork, cloud sessions, or scheduled routines,
because personal skills and both browser tool sets are absent there.

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

## The second rule — a stated requirement is a filter, not a weight

**Write the user's hard requirements down verbatim before searching, and pass
each one to `rank.mjs` as `--constraint <name>`.** There is no score high
enough to buy back a violated requirement, and no "but this one is better"
that survives it.

The failure this exists for: the user said **"they must be with wires"**. A
search turned up only pin-terminal modules, so the requirement was quietly
demoted to a preference and traded against things the ranker liked more —
current headroom, brand, certification. The result was a recommendation that
failed the one stated requirement, offered twice, the second time *after* the
user had supplied a wired counter-example. Three separate corrections from the
user ("not the socket type, wires", "must be with wires", "it's very simple AC
DC") did not stop it.

Three concrete obligations:

- **Never present an item that fails a stated requirement** — not as the pick,
  not as an alternative, not as "the one I would take" — unless the same
  sentence says it fails the requirement and the user is asked whether to
  relax it.
- **"I could not verify it" is not "it qualifies."** `rank.mjs` holds
  unverified items OUT of `ranked` and lists them under `unverified`. Check
  them or report them as unchecked; never let unchecked drift into the table.
- **If nothing satisfies the requirement, say exactly that.** An empty result
  is a finding and a legitimate answer. Substituting a violator is not.

Relaxing a requirement is the **user's** call. If you believe a requirement is
expensive, say so in one sentence — "this rules out the whole Hi-Link family,
which costs you X" — and let them decide.

## The third rule — for hardware, the photo is the spec sheet

**Read the label in the product images before quoting any rating.** Run
`listing.js`, download `gallery` with `labels.sh`, and read it. Text fields on
a listing are frequently absent, wrong, or junk; the silkscreen on the case is
the manufacturer's own number.

Measured: a RUIHONG RH-15W listing states its output current in **no** text
field. The variant selector offers voltage only (labelled "Color"), and the
spec table reads certification `NONE` and rated capacity `>1000VA` for a 59 g
part. The real rating, `OUTPUT: 9V1.6A`, is printed on the case and legible in
gallery image 1. Scraping text and inferring from a customer review produced
"~5 W, ~0.55 A" — wrong by about 3x — and that invented number was used to
argue against the product the user had chosen.

Corollary: **never report that something does not exist because a keyword
search missed it.** Titles omit physical attributes — wires, connector type,
mounting, enclosure, dimensions. A title search for "wire" returning zero says
something about titles, not about the world. `rank.mjs` now emits an
`absence-is-not-evidence` warning when a `--require` regex collapses the pool;
when you see it, go look at images and descriptions before writing a word
about absence.

## Step 0 — Pick the browser: signed-in Chrome first, in-app browser as fallback

A signed-in account sees the prices it will actually pay and the site's own
locale; the logged-out in-app browser sees geo defaults and new-buyer promo
prices capped at "1 per customer" (measured 2026-09-14: the same item read
`₪3.42` logged out and `US $9.37` in the signed-in cart). So prefer the
user's Chrome when it is there. Order:

1. **Detect the connector.** Load its tools in ONE ToolSearch call:
   `select:mcp__claude-in-chrome__list_connected_browsers,mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__tabs_close_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__javascript_tool,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__get_page_text,mcp__claude-in-chrome__browser_batch`.
   If the names are absent, or `list_connected_browsers` returns no browser
   with `isLocal: true`, go to the in-app browser (step 2) and say so in one
   line.
2. **Open a tab and check sign-in.** `tabs_context_mcp{createIfEmpty:true}`,
   then `navigate` to the first detail page you need anyway (never a wasted
   request). Read the header from the body text: a signed-in page shows
   `Hi, <name>` and `Account`; a logged-out one shows `Sign in / Register`
   (Hebrew: `התחבר / הרשמה`). Do this with text, not cookies — the connector
   blocks a result that contains cookie data.
3. **Signed in → use Chrome for the whole run.** Report which account name
   you saw and which locale/currency the header shows (`EN/ USD` etc.).
4. **Not signed in → stop and ask, as the headline of that turn:** "Chrome is
   connected but AliExpress is logged out there. Sign in in that tab, or say
   `fallback` to use the in-app browser (logged out, promo prices)." Do
   nothing until the answer. After a sign-in, re-read the header once to
   confirm before continuing.
5. **No connector → in-app browser**, exactly as before, plus
   `__aeHarvest.forceEnglish()` (step 2) so titles come back in English.

### Chrome connector rules — every one measured on 2026-09-14

The same scripts run in both browsers, but the connector's `javascript_tool`
has four hard limits that the in-app tool does not. Each is handled in code;
this list is so you do not fight the symptoms:

| Limit | Symptom | What to do |
|---|---|---|
| Result cut at **1,000 characters** | `…[TRUNCATED]` | Never return `payload()`. Use `__aeHarvest.expose(i)` + `get_page_text` (step 3). |
| Result with a cookie or a **query string** is replaced | `[BLOCKED: Cookie/query string data]` | Never return `document.cookie`, `location.href` of a search page, or any URL with `?`. `start()`/`status()`/`payload()` are already clean; `debugUrl()` is in-app only. |
| An async IIFE returns `{}` | `(async () => {...})()` → `{}` | Use a **top-level `await`**: `await __aeHarvest.step(6)`. |
| Call timeout between 25 s and 45 s | `CDP Runtime.evaluate timed out after 45000ms` | Keep `step(6)`; 25 s passed, 45 s failed. In-app dies at 30 s, so the unit of work is the same. |

Also: tab ids are **numbers** and must be passed explicitly inside
`browser_batch`; `get_page_text` returns at most 50,000 characters (the
`max_chars` argument is ignored there); close the tab you opened when done.

**Never change the account's language or currency in the signed-in browser.**
No `forceEnglish()` there, no settings clicks. The parsers accept both
`sold` and `נמכר`, and every item carries `currency`, so the account's own
locale is simply read as it is. A wall hit in the signed-in browser lands on
the user's own account session — the request budget (step 2) is not looser
there, it is the same number.

What was verified to work identically in the connector: JSON-LD on detail
pages, the shadow-DOM image walk, `fetch()` of search pages with the
account's cookies (page 1 of `clip flat mop` came back with 60 items in USD),
window state surviving between calls, screenshots, `find`/`read_page`.

## Step 1 — Build the search URL

Reduce the description to 2-4 English keywords. English queries work on
every storefront locale. Titles come back in the **page language**: Hebrew
with ILS prices in the logged-out in-app browser (unless `forceEnglish()`
was called), the account's language and currency in signed-in Chrome.
The host stays `he.aliexpress.com` even for English pages — the site
redirects `www.aliexpress.com/item/…` there with `gatewayAdapt=glo2isr` and
only the locale changes.

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

**Chrome connector:** `tabs_context_mcp{createIfEmpty:true}` then `navigate`
with the numeric `tabId` (step 0 already did this for the sign-in check —
reuse that tab).

**In-app browser:** if no browser pane is open, `preview_start` with the URL.
Otherwise `navigate`. `preview_start` is required first — `navigate` alone
errors with "No preview is open". Then, right after installing `harvest.js`
(step 3) and before `start()`, run `__aeHarvest.forceEnglish()` once: it
writes the three cookies the site's own language panel writes, so every later
fetch and page load is English with ILS prices (verified 2026-09-14: page
lang `en`, `₪6.38`, JSON-LD unchanged). Pass `{currency, region}` to change
the defaults `ILS`/`IL`. **Never call it in the signed-in Chrome.**

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

### The QUIET wall — and the screenshot that settles it

**The wall does not always announce itself.** Measured 2026-08-25: detail pages
came back with **279,005 bytes of HTML, 957 bytes of rendered body text and zero
JSON-LD nodes**. No marker matched. The operator read the empty body, reported
"**Not a wall** — a rendering fault", and built a product comparison on top of
that false negative — including telling the user a review count was "not
obtainable" when the page held **1,633**. The user found it, not the skill.

Two hard rules come out of it, both now enforced by `wallVerdict()` in `lib.mjs`
(inlined into all three browser files, drift-guarded by `test.mjs`):

- **A fired marker is never dismissible by argument.** In that session `punish`
  appeared in the HTML, and it was explained away as "the standard anti-bot SDK
  that ships on normal pages" — a claim that was never checked with a single
  command. *Constructing the explanation is the failure mode.* If a marker
  fires and no data came back, the state is `suspect`, and only a check clears
  it.
- **Take the screenshot. It is ONE call.** A stalled render and an interstitial
  are identical from the text channel — scraping harder can never separate
  them. `computer{action:"screenshot"}` ends the ambiguity immediately. This is
  the skill's own *"one channel drew a blank and the blank was treated as a
  finding"* defect (see defect 4 below), finally applied to block detection
  instead of only to product specs.

**Never write "not blocked", "no data available", or "this product does not
exist" from the text channel alone.** Look first.

`wallVerdict()` returns one of three states, and the ordering is the point:
`blocked` (loud markers — stop and headline), `suspect` (no data came back AND
a positive reason to suspect a wall — screenshot before concluding anything),
`clear` (data came back, so nothing withheld it — or the page is plainly a
short malformed response, which keeps its more useful `parse-error` name).
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
__aeHarvest.forceEnglish()                      // in-app browser ONLY, once
__aeHarvest.start({ query: 'wire brush set' })  // returns the plan (path, flags — no URL)
await __aeHarvest.step(6)                       // repeat until .done (top-level await)
__aeHarvest.payload()                           // in-app browser: JSON string for decode.mjs
```

`start()` deliberately returns the search **path** and flags, not the URL —
the Chrome connector blocks any result carrying a query string.
`__aeHarvest.debugUrl()` has the full URL when you are in the in-app browser.

`step(n)` is resumable because `javascript_tool` dies at 30 s in-app (and
between 25 s and 45 s in Chrome), which is about 8-12 fetches. Drive it with a
**top-level `await`** — an async IIFE comes back as `{}` in Chrome. Call it
repeatedly until `done: true`. It stops on `exhausted`, `page-cap`,
`request-budget`, `blocked`, `fetch-error` or `parse-error` — and
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

A full harvest is ~90KB per 400 items. **Primary channel, both browsers:**
the page POSTs it to a loopback receiver that writes the file. Start the
receiver as a background Bash task *before* the harvest so the harness
tracks it (it exits after one payload or 15 idle minutes):

```bash
node ~/.claude/skills/aliexpress-finder/scripts/receiver.mjs --dir <scratchpad> --port 8765
```

then in the browser:

```js
await __aeHarvest.send(8765)
// in-app:  "sent 91234 chars; receiver replied 200: saved <path> (…)"
// Chrome:  "form-posted 91234 chars to http://127.0.0.1:8765/harvest - the tab
//           now shows the receiver reply: get_page_text, then navigate back"
```

`send()` tries a `fetch()` POST first and, if Chrome holds it (its
local-network permission gate held such a request for 45 s without it ever
reaching the receiver, measured on Chrome 153), submits a top-level
`text/plain` form to the same URL. A form POST is a navigation, and it
arrived. The tab then shows `saved <path> (…)`: read it with
`get_page_text`, and `navigate` back to AliExpress. Window state is gone
after that navigation — export once, at the end of the harvest. Nothing is
retyped and nothing is chunked; the saved file is `harvest.json`.

**Fallbacks**, decoded by the one decoder:

```bash
node ~/.claude/skills/aliexpress-finder/scripts/decode.mjs <file...> > harvest.json
node ~/.claude/skills/aliexpress-finder/scripts/decode.mjs --check <file...>   # coverage only
```

- *In-app browser:* call `__aeHarvest.payload()`. The result exceeds the
  tool-result limit, the harness saves it to a file and prints the path —
  that file is the input to `decode.mjs` (double-encoded: a JSON array whose
  `text` field holds a JSON string; the decoder knows).
- *Chrome connector:* `payload()` would come back as 1,000 characters plus
  `[TRUNCATED]`. Export through the page: `__aeHarvest.chunks()` reports
  `{ total, chunkSize: 40000, count }`; `__aeHarvest.expose(0)` writes chunk
  0 into a `<pre>` placed FIRST in `<body>`; `get_page_text` reads it (its
  50,000-character cap cuts the page's own text, never the chunk); save the
  output to a file and repeat for `expose(1)`, `expose(2)`… Feed every dump
  to `decode.mjs` in any order — it checks all chunks arrived and refuses a
  partial payload.

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
... --require 'handle|hand |inch'        # English titles (signed-in Chrome, or in-app after forceEnglish())
... --require 'ידית|יד |אינץ'             # Hebrew titles (in-app browser without forceEnglish())
```

Write the regex in the language the titles came back in — check one title
first. A regex in the wrong language drops the whole pool and the
`absence-is-not-evidence` warning fires. In the measured run, a hand-brush
`--require` cut 1,166 to 187 and the ranking became answerable. Ask which
class the user wants, or present both.

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
    currency:p?.offers?p.offers.priceCurrency:null,
    sold:(body.match(/([\d.,]+\+?)\s*(?:sold|נמכר)/i)||[])[1]||null,
    ownReviews:/Review for this item/.test(body), pooled:/Review for similar item/.test(body) });
})()
```

JSON-LD carries rating, reviewCount, price and currency — but **not** sold count
and **not** brand. Sold comes from the body text (`sold` on an English page,
`נמכר` on a Hebrew one); brand comes from step 6. The `ownReviews`/`pooled`
flags matter: many listings show "Review for similar item", meaning the
review count is **pooled from other sellers' similar items** (the page says
so under the reviews). Report which kind a count is.

### Read the whole listing — both channels, one call

JSON-LD is the review numbers only. For anything physical — ratings, current,
dimensions, what is on the output — install `scripts/listing.js` and run:

```js
__aeListing.read()
```

It expands every "show more" first, then returns **text and images together**:
`sizeLines`, `ratingLines`, `variants`, `gallery`, `text`, plus a
`fingerprint`. One call, both channels, deliberately — see the defect below.

Three things it encodes that cost real time to discover:

- **`document.querySelectorAll('img')` returns ONE image on a detail page** (a
  240x240 icon) while dozens are displayed. The gallery lives behind a shadow
  root; a shadow-DOM walk finds ~74. `_dida_config_._init_data_` is **empty**
  on detail pages (length 2) — it only carries data on search pages. Every
  collector in `listing.js` recurses through `shadowRoot`.
- **Any mutation invalidates your previous read.** Expanding a description or
  selecting a variant changes the DOM. `changed(fp)` tells you whether a
  re-read is owed. If you clicked anything, you owe one.
- **A "size" line may be the shipping box.** `sizeLinesArePackage` separates
  them. `12 x 7 x 4 cm / 59 g` was the carton; the product was `8 x 3.7 x 2 cm`.

Then read the labels — this is not optional for hardware:

```bash
scripts/labels.sh fetch /tmp/labels <url1> <url2> ...
```

Downloads are **WebP even when the URL ends in .jpg**, so the script converts
to PNG (`sips`; PIL is not installed here). If the case text is too small to
read in the 800x800 shot — and it usually is — crop and upscale:

```bash
scripts/labels.sh crop /tmp/labels/img1.png 295 328 150 175
```

Reading the uncropped image is exactly how `OUTPUT: 9V1.6A` went unnoticed on
the first pass.

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

Add `reviews`, any `brandScore`, and a `constraints` status per hard
requirement to each finalist, then pass every requirement as `--constraint`:

```bash
node ~/.claude/skills/aliexpress-finder/scripts/rank.mjs --mode final --top 4 --constraint wires < finalists.json
```

Each item carries `{"constraints": {"wires": "pass" | "fail" | "unknown"}}`.
`fail` is dropped and counted in `constraintViolations`; `unknown` is held out
of `ranked` and listed under `unverified`. Both are reported — see step 8.

When any item carries a `brandScore`, weights are 0.60 quality / 0.25 volume /
0.15 brand, and items without one use the neutral `--brand-default` (0.5), are
flagged `brand-unresearched`, and are counted in `brandDefaulted`. When no item
carries one, brand weight is redistributed to 0 so nothing is scored on absent
data.

## Step 8 — Report

Table of the 4: title, detail price ₪, rating, review count, sold, brand verdict,
link. Then, briefly:

- **the hard requirements, and that every listed item passes them.** If any
  item in the table fails one, it does not belong in the table. If `ranked` is
  empty, say plainly that nothing satisfies the requirement — that is the
  answer, not a reason to substitute something else.
- **anything in `unverified`** — named, with what is unchecked about it. Never
  present an unverified item as satisfying a requirement.
- **which specs came from the product photo** rather than a text field, and any
  place where the two disagree. The photo wins; say so.
- **dimensions**, and whether the figure is the product or the shipping carton.
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
| `scripts/harvest.js` | **Primary.** Browser-side paged harvester: resumable, block-aware, reads until dry, reports `coverage.verdict`. Runs unchanged in both browsers; `forceEnglish()` (in-app only), `expose()`/`chunks()` (Chrome export), `debugUrl()` (in-app only). |
| `scripts/receiver.mjs` | **Primary export.** Loopback HTTP receiver; `__aeHarvest.send(port)` POSTs the payload to it and it writes `harvest-<query>-<stamp>.json`, replying with the path. Exits after one payload or 15 idle minutes. |
| `scripts/decode.mjs` | **Fallback decoder.** Reassembles a payload from the in-app harness file (double-encoded), from Chrome `get_page_text` chunk dumps (any order, refuses a partial set), or from a plain payload JSON. |
| `scripts/extract.js` | Single-page extractor for the currently loaded page. `_init_data_` first, DOM fallback, reports `source` and `blocked`. |
| `scripts/listing.js` | **Detail-page reader.** Expands, then returns text AND images in one call. Shadow-DOM aware, block-aware, separates product size from carton size, `changed()` proves a re-read is owed. |
| `scripts/labels.sh` | Downloads gallery images and makes their printed text readable (WebP→PNG, crop + upscale). The label on the case is the spec sheet. |
| `scripts/rank.mjs` | Ranker. Bayesian shrinkage, log volume, neutral brand default, `--require` filter, `--spread` tier stratification, `--constraint` hard filters, absence warning. |
| `scripts/lib.mjs` | Pure helpers (`parseSold`, `median`, `clean`, **`wallVerdict`**) shared by ranker, browser files and tests. |
| `scripts/test.mjs` | Assertion suite incl. regression guards for every defect below. |

`harvest.js`, `extract.js` and `listing.js` run in the browser and cannot import
`lib.mjs`, so each inlines `parseSold` and `wallVerdict` between `@shared:*`
markers. `test.mjs` pulls **every** copy out and asserts they match `lib.mjs` on
every fixture — keep them in sync, the test will catch you if you don't. A
drifted `wallVerdict` means one entry point silently stops detecting walls.

### Changes 2026-09-14 — signed-in Chrome first, English pages, one decoder

Not defects found by the user this time; a feature request, built only on
measured behaviour of the two browsers (the mop-and-sheets session).

1. **Chrome connector preferred when signed in** (step 0). Reason: a
   logged-out session sees geo defaults and 1-per-customer promo prices;
   the signed-in cart showed `US $9.37` for an item the logged-out page
   listed at `₪3.42`. The connector was tested for parity call by call
   before the skill was pointed at it; the four differences it has are in
   the step-0 table, and each is handled in code, not by operator memory.
2. **Locale-tolerant parsing.** `sold`/`נמכר` both match; `currency` is
   recorded per item from `salePrice.currencyCode` (grid) or
   `offers.priceCurrency` (JSON-LD); the DOM fallback reads `₪`, `US $`,
   `€`, `£`. A signed-in account's own locale is read as it is — never
   changed. Guard: test.mjs parses an English and a Hebrew grid side by side.
3. **`forceEnglish()`** for the logged-out in-app browser: the three cookies
   the site's language panel writes, verified to turn a Hebrew page into an
   English one with ILS prices and unchanged JSON-LD. Never for Chrome.
4. **No query strings in any returned value.** The connector replaces such a
   result with `[BLOCKED: Cookie/query string data]`; `start()` and
   `payload()` used to carry the full search URL, so in Chrome neither could
   ever be read back. Guard: test.mjs asserts no `?` in `start()`,
   `status()`, `payload()`.
5. **`send()` + `receiver.mjs`, with `expose()` + `decode.mjs` as fallback.**
   The connector cuts a `javascript_tool` result at exactly 1,000 characters
   (measured with position markers) and `get_page_text` at 50,000 (its
   `max_chars` is ignored), so no payload can come back through a tool
   result without hand-copying. The page now POSTs the payload to a loopback
   receiver that writes the file and replies with its path — no retyping, no
   chunking, same in both browsers. Chrome 153 held a `fetch()` to loopback
   behind its local-network permission (never arrived in 45 s), so `send()`
   races the fetch against a timeout and falls back to a top-level form POST,
   which arrived. If loopback is unreachable altogether, the payload is
   written into the page 40,000 characters at a time and read back by
   `get_page_text`; the decoder checks every chunk arrived. The same decoder
   replaces the inline double-decoding snippet for the in-app file, so there
   is one decoder, tested, instead of a snippet retyped per run.
6. **Pooled reviews flagged.** Many detail pages show "Review for similar
   item": the review count is aggregated across sellers. The step-5 snippet
   now returns `ownReviews`/`pooled` so the report can say which it is.

### Defect fixed 2026-08-25 — the quiet wall (the jump-starter session)

**A human-verification wall was hit and reported to the user as "Not a wall".**
The detection ran, one marker (`punish` in the HTML) *fired*, and it was argued
away with an unverified claim. No screenshot was ever taken, though the tool was
available the whole time. The false negative then propagated: PAIVIROKU review
counts were reported as "not obtainable" and a brand comparison was written on
that basis. The page held 1,633 reviews and rendered fine minutes later.

Three failures, one root: **a blank in one channel was treated as a finding.**

Guards added: `wallVerdict()` replaces the old boolean `blockedBy()` in all
three browser files; it returns `suspect` for the big-HTML/empty-body/no-data
shape and for any quiet marker with no data, and its `note` mandates a
screenshot in words. `test.mjs` asserts the exact 279,005/957/0 shape is not
called clear, that a punish string with no data is not clear, that a page which
*did* serve data stays clear (no false alarms), and that all three inlined
copies agree with `lib.mjs`.

### Defects fixed 2026-08-21, second wave — the Tapo C222 session

All four were found by the user, not by the skill. Each now has a guard in code
plus an assertion in `test.mjs`, because the prose rules that should have
prevented them were already written and were not enough.

1. **A stated requirement was treated as a tradeable weight.** The user said
   "must have wires"; a pin-terminal module was recommended anyway, twice —
   the second time after the user had produced a wired counter-example, on the
   strength of an invented current figure. Guard: `rank.mjs --constraint`
   drops `fail` items and refuses to rank `unknown` ones; an empty result is
   reported as an empty result. See "The second rule".

2. **Absence declared from a single evidence channel.** A title-keyword search
   for "wire" found nothing and was reported to the user as "wired 9 V modules
   do not exist". They exist. Titles do not carry physical attributes. Guard:
   `absence-is-not-evidence` warning fires in-band when a `--require` regex
   collapses the pool.

3. **The spec was read from text while the number was printed on the photo.**
   A customer review saying "~15.1 V at 0.35 A" was turned into "this is a 5 W
   part, ~0.55 A at 9 V" and used to steer a recommendation. The case label
   said `OUTPUT: 9V1.6A` — off by about 3x. The photo had already been looked
   at, for *shape*, and then abandoned in favour of text for *specs*. Guard:
   `listing.js` always returns `gallery` next to the text and carries a
   `reminder`; `labels.sh` makes the label readable.

4. **The page was mutated and never re-read.** "Show more" was clicked three
   times — page grew 6,567 → 11,172 px — and only an *image* scan was run on
   the newly revealed content. The size line sat in that text. It was then
   declared "not published anywhere" while visible on screen. Guard:
   `listing.js.read()` expands first and returns both channels in one call, so
   the gap cannot open; `changed(fp)` proves when a re-read is owed.

The single sentence behind all four: **one channel drew a blank, and the blank
was treated as a finding.** Text-only for the current, images-only for the
size, titles-only for existence. Before writing "there is no X" or "X is not
stated", check the other channel — and say which channels you actually checked.

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
