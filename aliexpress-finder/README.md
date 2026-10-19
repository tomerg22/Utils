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
| `scripts/harvest.js` | Browser-side paged harvester. Resumable, reads until an empty page or a page with no new ids (the server's `finished` flag is not trusted: it was true on every page of a 230-item stream), detects the anti-bot wall *before* parsing so a block can never be mistaken for a parse error, and flags a stream whose titles do not match the query (`off-query`). Saves its state to `localStorage` after every page; `restore()` reloads the run saved last in a fresh tab, `resume()` clears a stop, `startPage` skips saved pages, and `maxPages` stops at page 60, the last page the site serves. `send()` replies `DELIVERED` / `NOT DELIVERED` / `UNCONFIRMED`. `send(port, {via: 'form'})`, the export to use, always posts the form, so it navigates even to a dead port: curl the receiver first, and `restore()` is the way back. A plain `send()` never navigates after a refused fetch. Runs unchanged in both browsers: `forceEnglish()` for the logged-out in-app browser, `expose()`/`chunks()` to export through the Chrome connector, both `sold` and `נמכר` parsed, currency per item, tab `visibility` reported |
| `scripts/extract.js` | Single-page extractor for the currently loaded page. Reads the embedded `_dida_config_._init_data_` payload (~60 records), falls back to DOM scraping (`₪`, `US $`, `€`, `£`), and flags captcha interstitials. The result also stays on `window.__aeExtract`, because the Chrome connector cuts the return at 1,000 characters: return pieces of it, or post it all to the receiver with `__aeExtract.send(port)` |
| `scripts/receiver.mjs` | Loopback HTTP receiver: after a `curl` check, `__aeHarvest.send(port, {via: 'form'})` POSTs the harvest payload to it from either browser (a plain `send(port)` fetch was refused by both on 2026-10-18), and it writes `harvest-<query>-<stamp>.json` and prints `saved <path>` in its own output. No retyping, no chunking. Takes any number of payloads, exits after 60 idle minutes, `GET /` answers `ok …` |
| `scripts/decode.mjs` | Fallback decoder and merger: reassembles a payload from the in-app harness file (double-encoded), from Chrome `get_page_text` chunk dumps in any order (refuses a partial set), or from a plain payload JSON or an array of them; several payloads are merged and deduped, never dropped |
| `scripts/fixtures/` | Test data: the titles of two real 2026-10-17 harvests (a craft-wire stream served for `wired usb mouse`, and a real mouse stream), for the relevance tests |
| `scripts/build.mjs` | Writes `scripts/dist/*.min.js`, the browser files without comments, for the install paste (about 45% of the source). Run it after editing a browser file; the tests fail on a stale copy |
| `scripts/listing.js` | Detail-page reader (`await read()`). Expands the page, then returns text **and** images in one call; walks the shadow DOM (a bare `querySelectorAll('img')` sees 1 image of dozens); `gallery` is the product's own photos only, full size, with other products counted apart; reads the description from its shadow root, or fetches it when a hidden tab left it unrendered; separates product size from carton size, reads options only from the option selector (every selected one), returns the Specifications rows and own vs pooled review counts, reports tab `visibility` and warnings |
| `scripts/labels.sh` | Downloads gallery images and makes their printed text readable (WebP→PNG, crop + upscale). For hardware the label on the case is the spec sheet |
| `scripts/rank.mjs` | Scoring: shrunk quality (the listing's own rating in final mode) + log-scaled volume + optional brand score, `--require` category filter, `--spread` tier stratification, `--constraint` hard requirement filters, absence-is-not-evidence, off-query and tie-at-cutoff warnings, `sold-unparsed` and `own-reviews-unknown` set-asides, strict flag values |
| `scripts/lib.mjs` | Pure helpers shared by the ranker, the browser files, the step-5 reader and the tests |
| `scripts/test.mjs` | Test suite — 1125 assertions, including the step-5 reader pulled out of `SKILL.md` and the harvest scenarios run on the `dist` copy |

## Tests

```bash
node scripts/build.mjs   # after editing a browser file
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
- a harvest lost on export: `send()` navigated to a dead receiver port after
  a refused fetch, with no backup; the receiver had exited after one payload
- an off-category stream (craft wire for `wired usb mouse`) reported as all
  results, and ranked without a warning
- a recovery harvest that re-read saved pages, a zero budget turned into 24,
  and a decoder that kept only the first of two payloads
- the pooled rating ranked with the own count, a researched house brand
  ranked below unresearched items, ties and bucket floors misread
- a product size marked as the carton, a bold-label size skipped, a wall or
  an HTTP error page read as the description, the description cut off
- a title's "Bluetooth 5.0" read as the rating
- a correct stream called off-query: short plurals (`toys`, `boxes`), `-ss`
  nouns (`dresses`), split compounds (`Screw Driver`), English titles with
  `pour` or `les`; backups ranked by start time, not save time; a `maxPages`
  past the site's page 60 that ended as all results
- a lunch box's own size called the carton; a product size lost when the
  same line held the package size; a real description that starts with `[`
  thrown away with its images; a served search page called a wall because
  a title said "please slide"; the step-5 reader cutting the selected option
  first, taking the first digit of the sold count, and reading spec rows past
  the end of the spec block

`harvest.js`, `extract.js` and `listing.js` run in the browser and cannot import
`lib.mjs`, so each inlines the helpers it needs (`parseSold`, `SOLD_RE`,
`parseReviewBlock`, `wallVerdict`, `queryRelevance`) between `@shared:*`
markers, and so does the step-5 reader in `SKILL.md`. The test suite pulls every copy out and asserts it
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
