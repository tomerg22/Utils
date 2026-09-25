# aliexpress-finder

A [Claude Code](https://claude.com/claude-code) skill that finds the best
AliExpress listings for a described product and returns the top 4 with evidence.

## Why it exists

AliExpress ranking signals are easy to misread:

- **Raw rating is not comparable.** 5.0 from 3 reviews is weaker evidence than
  4.8 from 5,000. Ratings are shrunk toward the pool mean, weighted by evidence.
- **Sold counts are bucketed** (`10,000+`, `50,000+`, `100K+`), so the top of
  any category ties. The tie-break is the listing's own rating count, read
  from the review block on the detail page. The JSON-LD review count is not
  it: on most listings that number is pooled across other sellers' similar
  items (header 5,479 vs own 1,090 on one listing).
- **A real brand name does not mean a real product.** Listings are checked for
  price/spec plausibility, so a counterfeit wearing a strong brand is demoted
  rather than promoted.
- **One page of results is not the catalogue.** Reading only the first ~60 hits
  makes recall a function of how well you guessed the listing's wording. The
  harvester pages until the stream runs dry, then reports whether it exhausted
  the results or was cut short — never a percentage of the site's own result
  count, which is unreliable (one query claimed 160,188 results and served four
  pages).
- **Bucketed sold counts hide good listings.** Because `sold` saturates, the top
  of a shortlist is all `10,000+` and the one signal that would promote a
  strong moderate-sold item — its exact review count — only exists on a page
  the shortlist decides whether to fetch. `--spread` breaks that loop by
  sampling across sold tiers.

## Install

```bash
git clone https://github.com/tomerg22/Utils.git
cp -r Utils/aliexpress-finder ~/.claude/skills/
```

Then invoke it in Claude Code:

```
/aliexpress-finder cordless drill with one battery
```

Runs in the user's own signed-in Chrome when the Claude in Chrome connector
(`mcp__claude-in-chrome__*`) is present — the account sees its real prices and
locale — and falls back to the in-app browser (`mcp__Claude_Browser__*`)
otherwise, where it forces English pages with the region's currency. If Chrome
is connected but logged out of AliExpress, the skill asks the user to sign in
or to say `fallback`. Either way it is local Claude Code only — not cloud
sessions or scheduled routines.

The Chrome connector's script tool cuts results at 1,000 characters, blocks any
result carrying a cookie or a query string, and returns `{}` for an async IIFE
(all measured 2026-09-14). The harvester never returns a URL with a query
string, POSTs its payload to a loopback receiver that writes the file
(`send()` + `receiver.mjs`; page-text chunks are the fallback), and is driven
with a top-level `await`. The signed-in account's language and currency are
read as they are, never changed.

## Layout

| File | Role |
|------|------|
| `SKILL.md` | The skill: 8-step workflow plus gotchas verified against the live site |
| `scripts/harvest.js` | Browser-side paged harvester. Resumable, reads until the result stream is dry, detects the anti-bot wall *before* parsing so a block can never be mistaken for a parse error. Runs unchanged in both browsers: `forceEnglish()` for the logged-out in-app browser, `expose()`/`chunks()` to export through the Chrome connector, both `sold` and `נמכר` parsed, currency per item |
| `scripts/extract.js` | Single-page extractor for the currently loaded page. Reads the embedded `_dida_config_._init_data_` payload (~60 records), falls back to DOM scraping (`₪`, `US $`, `€`, `£`), and flags captcha interstitials |
| `scripts/receiver.mjs` | Loopback HTTP receiver: `__aeHarvest.send(port)` POSTs the harvest payload to it from either browser and it writes `harvest-<query>-<stamp>.json`, replying with the path. No retyping, no chunking. Exits after one payload or 15 idle minutes |
| `scripts/decode.mjs` | Fallback decoder: reassembles a payload from the in-app harness file (double-encoded), from Chrome `get_page_text` chunk dumps in any order (refuses a partial set), or from a plain payload JSON |
| `scripts/listing.js` | Detail-page reader. Expands the page, then returns text **and** images in one call; walks the shadow DOM (a bare `querySelectorAll('img')` sees 1 image of dozens), separates product size from carton size, reads options only from the option selector, returns own vs pooled review counts |
| `scripts/labels.sh` | Downloads gallery images and makes their printed text readable (WebP→PNG, crop + upscale). For hardware the label on the case is the spec sheet |
| `scripts/rank.mjs` | Scoring: shrunk quality + log-scaled volume + optional brand score, `--require` category filter, `--spread` tier stratification, `--constraint` hard requirement filters, absence-is-not-evidence warning, `sold-unparsed` and `own-reviews-unknown` set-asides |
| `scripts/lib.mjs` | Pure helpers shared by the ranker, the browser files, the step-5 reader and the tests |
| `scripts/test.mjs` | Test suite — 333 assertions, including the step-5 reader pulled out of `SKILL.md` |

## Tests

```bash
node scripts/test.mjs
```

Covers the scoring guarantees and carries a regression guard for every defect
found during live runs:

- `.`-as-thousands-separator sold counts (`4.000+`) parsing as `4`
- DOM extraction capping at 13 of 60 records
- a missing brand score treated as `0`, letting a counterfeit outrank a
  legitimately brandless listing
- a single page of 60 treated as the whole result set
- **an anti-bot wall parsed as `null` and logged as a parse failure** — the
  harvester now checks for it before parsing, and the tests assert that a
  blocked page, a body-only captcha, and a genuinely malformed page produce
  three *different* stop reasons
- the site's own `totalResults` used as a coverage denominator
- a shortlist sampled only at its head, so a strong-review listing could never
  earn the review count that would promote it
- a search URL returned to the operator, which the Chrome connector blocks
  outright; and a payload returned through a channel that cuts it at 1,000
  characters — the tests assert no `?` in any returned value and round-trip
  the chunked export through the decoder, chunks arriving out of order
- an English page parsing every sold count to `null` because only the Hebrew
  marker was known — an English and a Hebrew grid are parsed side by side
- `100K+ sold` read as `null`, so the two best sellers of a 1,228-item pool
  were dropped as thin evidence without a warning; an unreadable sold text is
  now set aside as `sold-unparsed` and named
- the step-5 review count taken from JSON-LD, which is pooled across other
  sellers' similar items; the reader now returns the listing's own count and
  the pooled one separately, and the ranker refuses to rank on the pooled one
- listing options read from reviews of other sellers' items instead of the
  option selector

`harvest.js`, `extract.js` and `listing.js` run in the browser and cannot import
`lib.mjs`, so each inlines the helpers it needs (`parseSold`, `SOLD_RE`,
`parseReviewBlock`, `wallVerdict`) between `@shared:*` markers, and so does the
step-5 reader in `SKILL.md`. The test suite pulls every copy out and asserts it
agrees with `lib.mjs` on every fixture, so they cannot silently drift.

The harvester's own logic is tested by loading the real file with a fake
`window` and `fetch` — not by reimplementing it in the test, which is how a
confidently wrong "proof" gets written.

## Note on scale

Fine for occasional personal shopping — one product search at a time, a few
dozen requests. AliExpress's Terms of Use prohibit systematic retrieval of site
content to build a collection or database, and the site enforces it: sustained
automated requests trigger a slider captcha. The harvester ships with a request
budget (`maxRequests`, default 24) partly for this reason, and it stops and
reports rather than working around a challenge. Don't turn this into a bulk
harvester, and don't run it unattended.
