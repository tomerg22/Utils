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

Sanity-check the tooling whenever you change it. After editing a browser
file, rebuild its install copy first (the tests fail on a stale one):

```bash
node ~/.claude/skills/aliexpress-finder/scripts/build.mjs
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
   blocks a result that contains cookie data. In the same call return
   `document.visibilityState`: `hidden` changes what works (next section).
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
| Result cut at **1,000 characters** | `…[TRUNCATED]` | Never return `payload()`. Export with `await __aeHarvest.send(<port>, {via: 'form'})` to `receiver.mjs` (step 3). `expose(i)` + `get_page_text` is the fallback, visible tab only. |
| Result with a cookie or a **query string** is replaced | `[BLOCKED: Cookie/query string data]` | Never return `document.cookie`, `location.href` of a search page, or any URL with `?`. `start()`/`status()`/`payload()` are already clean; `debugUrl()` is in-app only. |
| An async IIFE returns `{}` | `(async () => {...})()` → `{}` | Use a **top-level `await`**: `await __aeHarvest.step(6)`. |
| Call timeout between 25 s and 45 s | `CDP Runtime.evaluate timed out after 45000ms` | Keep `step(6)`; 25 s passed, 45 s failed. In-app died at 30 s (2026-09-14) and at 45 s (2026-09-29), so the unit of work is the same. |

Also: tab ids are **numbers** and must be passed explicitly inside
`browser_batch`; `get_page_text` returns at most 50,000 characters (the
`max_chars` argument is ignored there); close the tab you opened when done.
`tabs_context_mcp{createIfEmpty:true}` creates a blank starter tab when the
group is empty, and that tab is the work tab. If you open another one with
`tabs_create_mcp`, close the starter tab as well at the end.

### A hidden tab — measured 2026-09-29

The connector's tab lives in its own Chrome window. When that window is
minimised or fully covered, Chrome marks the tab `hidden`. On 2026-09-29
both tabs of the run were hidden, one of them seconds after it was opened.
In that state:

| Works | Hangs or breaks |
|---|---|
| `javascript_tool`, `navigate`, form POSTs | `computer` screenshot and zoom, `get_page_text`: each hung until the 45 s timeout |
| JSON-LD, the option selector, the review block | page timers: a 100 ms `setTimeout` fired after 958 ms; a 2,500 ms one had not fired 45 s later |
| `fetch()`: 7 search pages and 3 description fetches went through on 2026-09-29 | `fetch()` on 2026-09-17: after a tab had been hidden for a while, fetch and XHR stayed pending until the 45 s limit |
| | lazy rendering: the product description was not rendered anywhere (the page had fetched it) |

When `fetch()` hangs (`step()` or `read()` times out with no result), do
NOT close the tab first: the harvest lives in that tab's `window`. Since
2026-10-18 `harvest.js` also saves it to `localStorage` after every page
(`status().backup`), and `localStorage` belongs to the origin, not the tab.

1. Check the receiver is up: `curl -s http://127.0.0.1:8765/` must answer
   `ok …`. It has no payload limit and exits after 60 idle minutes; if it is
   gone, start it again (step 3). **Do not skip this check in a hidden
   tab, or in a visible one.** `send(<port>, {via: 'form'})` never tries a
   fetch. It always posts the form, and a form POST is a navigation. So
   with the receiver gone, the tab navigates to an error page, visible or
   hidden. The curl check is the only guard against a dead port. Then
   only the `localStorage` backup (and `restore()`) is left. A plain
   `send()` posts the form at once in a hidden tab too, because it cannot
   test the port there (the test needs a timer).
2. In the stuck tab, `__aeHarvest.status()` still answers. Export what you
   have: `await __aeHarvest.send(<port>, {via: 'form'})`. It posts the form
   and needs no fetch and no timer. The reply starts with `UNCONFIRMED`:
   the receiver's own output must print `saved <path>`. For a detail page,
   `__aeListing.last` holds everything but the description.
3. Then close the tab and open a fresh one with `tabs_context_mcp`. That
   recovered the 2026-09-17 run.
4. In the new tab (any `he.aliexpress.com` page), install `harvest.js` and
   call `__aeHarvest.restore()`. The saved harvest comes back with its
   items, the pages read, the requests spent and its `stop`. **If the reply
   shows a `stop`, call `__aeHarvest.resume()` before `step()`.** `step()`
   reads nothing while a stop is set, and the reply's `note` names the call
   (`resume({ maxRequests })` for a `request-budget` stop, `resume({
   maxPages })` for a `page-cap` stop below page 60). A `blocked` or
   `suspect-wall` stop is a wall: go to Step 2 (the wall) before you
   resume. An `exhausted` stop is the end of the stream: export it. Then `await
   __aeHarvest.step(6)` carries on from the next unread page; the requests
   still count toward the wall budget. `__aeHarvest.backups()` lists what is
   saved, the run saved last first. `restore()` with no query takes that
   run, and `restore(query)` the run of that query saved last. Only when `restore()` finds nothing: `start({ query, startPage:
   <last page read + 1>, maxRequests: <24 minus the requests spent> })`,
   plus the SAME `fourStar` and `extra` as the first run (other filters are
   another search stream, and `decode.mjs` will not join their pages), so
   the budget is not spent re-reading saved pages. `maxRequests: 0` means
   no request is left; it is not replaced by the default any more.
5. Export again. Two saved payloads merge with `decode.mjs a.json b.json >
   harvest.json`: items are deduped by id, and the merged verdict is
   `exhausted-all-results` only when the pages read, together, run from
   page 1 with no gap up to where the stream ran dry. Only `decode.mjs`
   gives a merged verdict: `rank.mjs` on an array merges the items, but
   reports no coverage.

What to do:

- **Read `visibility` first.** `harvest.js` `status()`, `extract.js` and
  `listing.js` `read()` all report it. `listing.js` adds a `tab-hidden`
  warning.
- **Never wait inside the page.** No `setTimeout`, no `await sleep`, in any
  snippet you write. To wait, use the tool's own `computer{action:"wait"}`
  between calls. A page timer can outlive the tool call, and then the result
  is lost.
- **A screenshot needs the window in front.** When one is required (a
  `suspect` wall, step 2), headline it: "The AliExpress tab is hidden: please
  bring that Chrome window to the front." Until then, report the wall as
  unresolved. Never report "not blocked".
- **Exports still work.** `__aeHarvest.send(<port>, {via: 'form'})` posts
  the form in a hidden tab as in a visible one, after saving the harvest to
  `localStorage`. (A plain `send()` sees `hidden` and skips its fetch race,
  which needs a timer, so it posts the form too.) The reply starts with
  `UNCONFIRMED`: read the saved path from the receiver's own output (the
  background task), not from the tab. `expose()` + `get_page_text` does NOT
  work hidden.
- **The description is fetched, not rendered.** `listing.js` fetches it from
  the URL the page already requested; `description.source` says `fetched`.

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
guessed words. The whole list is far over the Chrome connector's 1,000
characters, so the snippet keeps it on `window.__aeRefine` and returns one
short line per group. `test.mjs` runs it from this file.

<!-- @snippet:refine:start -->
```js
(() => {
  window.__aeRefine = window._dida_config_._init_data_.data.data.root.fields.mods
    .searchRefineFilters.content.map((g) => ({ title: g.title, paramName: g.paramName,
      attributeId: g.attributeId,
      opts: (g.content || []).map((o) => ({ text: o.text, value: o.selectedValue })) }));
  const s = window.__aeRefine.map((g, i) => i + ' ' + g.title + ' ' + g.paramName + ' (' + g.opts.length + ')').join(' | ');
  return s.length > 990 ? s.slice(0, 950) + ' ... cut: ' + window.__aeRefine.length + ' groups' : s;
})()
```
<!-- @snippet:refine:end -->

Then read one group per call, in pieces under 1,000 characters:
`JSON.stringify(__aeRefine[3].opts.slice(0, 15))`, then `slice(15, 30)`.
In the in-app browser `JSON.stringify(__aeRefine)` returns it all.

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
- **A page that served items is not a wall because of a title.** On such a
  page, `extract.js` and `harvest.js` count only the wall's own sentences
  ("unusual traffic", "slide to verify") in the text. "Please slide" alone
  does not count there: a door-lock title said "please slide to lock". The
  URL and the captcha HTML always count.

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
  instead of only to product specs. **In a hidden tab the screenshot hangs**
  (step 0, "A hidden tab"): ask the user to bring the window to the front,
  and keep the wall unresolved until you have looked.

**Never write "not blocked", "no data available", or "this product does not
exist" from the text channel alone.** Look first.

`wallVerdict()` returns one of three states, and the ordering is the point:
`blocked` (loud markers — stop and headline), `suspect` (no data came back AND
a positive reason to suspect a wall — screenshot before concluding anything),
`clear` (data came back, so nothing withheld it — or the page is plainly a
short malformed response, which keeps its more useful `parse-error` name).
- When they say it is cleared, verify with ONE request and report what it
  returned before going on: `__aeHarvest.resume()` then
  `await __aeHarvest.step(1)`. `resume()` clears the stop and keeps every
  item, and the page that hit the wall is fetched again. Never `start()`
  again for this: it throws the harvest away.

**Budget your requests.** The wall tripped after roughly 50-60 rapid fetches in
one session. That is a measured count, not a documented limit, so treat it as an
order of magnitude. A normal task fits comfortably: one harvest of ~20 pages
plus ~10 detail pages is ~30 requests. Two harvests plus detail pages is near
the edge. Three is over it.

**Every code path that can fetch MUST carry block detection with it.** A blocked
response has no payload, so a naive parser returns null and the caller logs
"parse failed" — which reads like a bug, not a wall. `harvest.js` runs
`wallVerdict()` *before* parsing and sets `stop: 'blocked'` (or
`'suspect-wall'` for a quiet wall); `extract.js` and `listing.js` set
`blocked: true` / `suspectedWall: true`. Never add a fetch path without one
of them.

## Step 3 — Harvest (paged)

Pass the **entire contents** of `scripts/dist/harvest.min.js` as the `text`
argument of `javascript_tool`. It is `scripts/harvest.js` without comments
and indentation (about 34 KB instead of 78 KB), generated by
`node ~/.claude/skills/aliexpress-finder/scripts/build.mjs`, and it has no invisible characters: the bidi
marks the parsers strip are written as `\u` escapes. Never retype or shorten
either file: only these two copies are tested. `test.mjs` runs the WHOLE suite
a second time on the three dist copies (`harvest`, `listing`, `extract`,
with `AEF_DIST=1`), and fails when a dist copy is stale; `build.mjs` refuses a
copy that does not parse or is not the same program as its source (node's
own parser compares the two). It installs
`window.__aeHarvest` and returns a status string. Installing again while a
`step()` loop runs is refused; installing again when idle keeps the
current harvest.

```js
__aeHarvest.forceEnglish()                      // in-app browser ONLY, once
__aeHarvest.start({ query: 'wire brush set' })  // returns the plan (path, flags — no URL)
await __aeHarvest.step(6)                       // repeat until .done (top-level await)
await __aeHarvest.send(8765, {via: 'form'})     // export to receiver.mjs (below; curl it first)
__aeHarvest.restore()                           // a fresh tab: reload the saved harvest (a stop: resume() first)
__aeHarvest.payload()                           // in-app browser: JSON string for decode.mjs
```

`start()` deliberately returns the search **path** and flags, not the URL —
the Chrome connector blocks any result carrying a query string.
`__aeHarvest.debugUrl()` has the full URL when you are in the in-app browser.

`step(n)` is resumable because `javascript_tool` dies at 30 s in-app (and
between 25 s and 45 s in Chrome), which is about 8-12 fetches. Drive it with a
**top-level `await`** — an async IIFE comes back as `{}` in Chrome. Call it
repeatedly until `done: true`. It stops on `exhausted`, `page-cap`,
`request-budget`, `blocked`, `suspect-wall`, `fetch-error` or
`parse-error`:

- **`blocked`** means go to step 2 and alert the user, as the headline.
- **`suspect-wall`** means no data came back and a wall marker fired. Take
  a screenshot before anything else (step 2, the quiet wall); never report
  it as a short harvest or as "no results".
- **`fetch-error`**, **`parse-error`**: read `lastErr`. `__aeHarvest.resume()`
  clears the stop and keeps the items, so one retry costs one request.
  A non-2xx reply (`http 429`, `http 503`) and a redirect off the storefront
  (a login page) are `fetch-error`s that name the status or the host. A page
  whose rows mostly have no `productId` is a `parse-error` (`shape:…`), not
  the end of the stream: the site changed its format.
- **`request-budget`**, **`page-cap`**: the run was cut short on purpose.
  `resume({ maxRequests })` lifts a `request-budget` stop and
  `resume({ maxPages })` a `page-cap` stop, only if the wall budget (step 2)
  allows it.
- **`exhausted`** carries an `endSignal`: `empty-page` (the server served
  nothing) or `no-new-ids` (every id on the page was already seen).

**After a `step()` call times out, its loop is still running** in the page
(a promise cannot be cancelled). Do not call `step()` again at once: it
would be refused with `err: 'step() is already running …'`. Wait with
`computer{action:"wait"}`, poll `status()` until `running: false`, then
call `step()` again. (Before this guard, an overlapping call fetched the
same page twice, found no new ids and ended a 600-item run at 240 as
`exhausted-all-results`; measured by the 2026-09-29 review.)

**`pageInfo.finished` is ignored, on purpose.** Measured 2026-09-29 in
signed-in Chrome: `cheese grater` reported `finished: true` on pages 1, 2 and
3 while page 3 still held 60 ids never seen; the stream served 60, 60, 60, 50
and then an empty page. Trusting the flag stopped the run after page 1 and
would have reported 60 of 230 items as `exhausted-all-results`. A short page
is not the end either: `vegetable slicer` served 48 on page 4 and 1 more item
on page 5. Reading to the empty page costs one request. Each entry in
`payload().pages` still records the flag, for diagnosis.

Defaults are `maxPages: 20` (the last page number read), `maxRequests: 24`,
`startPage: 1`, `fourStar: true`. `maxRequests: 0` is a budget of zero, not
the default. The site serves no page past 60. So a `maxPages` above 60 is
cut to 60, and the plan (or the `resume()` reply) says so in `note`. A run
that reaches page 60 stops as `page-cap`, and its verdict is `truncated`,
never `exhausted-all-results`. `resume()` cannot lift that stop. A
`startPage` above 60 is refused.

**Read until the stream runs dry, then report which happened.** Do not assume a
fixed depth — it varies enormously by query and is not even stable between runs:

| Query | Served |
|---|---|
| `wire brush set` (4★) | 1,166 unique over 20 pages, still going at the cap |
| `travel duffel bag` (4★) | 473 over 8 pages, 98% on-category, still going |
| `balance board roller` (4★) | dry at page 5 — and page 7 an hour earlier |
| `cheese grater` (4★, signed-in Chrome) | 230 over 4 pages, empty page 5 |
| `rotary grater` (4★, signed-in Chrome) | 23 on page 1, empty page 2 |

**`pageInfo.totalResults` is not a denominator.** The balance-board query
claimed **160,188** results and served nothing past page 4. In signed-in
Chrome it did the opposite: it grew with each page read (60, 120, 180), so it
counted what had been served. Never report coverage as a percentage of it.
Report `coverage.verdict`: `exhausted-all-results`, `truncated`,
`exhausted-from-start-page` (a `startPage` run: merge it before calling it
complete) or `off-query` (below).

**Paging works — the old warning was wrong.** This file used to claim `&page=2`
returns recommendations rather than results. Measured: pages 1-12 of `wire brush
set` gave 709 unique items with 59-60 fresh on *every* page, zero duplicates and
zero category drift. Drift is real but only **deep** and only **unfiltered** —
page 40 of an unfiltered brush search returns hair clips, and page 60 is the
hard ceiling. With the 4★ filter, on-category stayed 97-100% through page 20
on `wire brush set` and `travel duffel bag`. That is two queries, not a
guarantee.

**Check that the stream is the product at all.** Measured 2026-10-17: the
slug `wholesale-wired-usb-mouse` was served as craft wire, 281 of 282
items, and the run ended `exhausted-all-results` with no warning. Now
`payload().relevance` (and `status().relevance`, short) counts the titles
holding at least one query keyword as a whole word. A plural counts (`toys`
for `toy`, `dresses` for `dress`), and so does a shared stem (`charging`
for `charger`). Two words written apart count as one word (`Screw Driver`
for `screwdriver`). `wire` is not `wired`, `tubes` is not `tub`, and
`Wire D Ring` is not `wired`. When fewer than half of the
titles hold a keyword, `coverage.verdict` is `off-query`,
`payload().warnings` says so, and `rank.mjs` repeats the warning.

**Read the off titles before you act on `off-query`.** The check cannot see
a synonym. Titles that say `Earbuds` for `earphones`, or `Cam` for
`camera`, count as off. So first read `relevance.offSample`: up to 3 titles
that hold no keyword (the warning quotes them too; on the two warnings
below, titles that lack every missing keyword). If they are the product
under another name, the stream is fine. Its own verdict is
`coverage.streamVerdict`; tell the user why you kept it. If they are
another product, the harvest is not a result: re-word the query (`usb
wired mouse`, `mouse wired`), tell the user, and never report the stream
as all results. A `decode.mjs` merge keeps the same two fields:
`relevance.offSample`, and `coverage.streamVerdict` for the whole merge
(`coverage.byQuery[]` has both per stream). The code cannot fix this
limit. Only you can, by reading the titles.

**One word can carry another category.** Measured 2026-10-19, twice in
one day. `poco f7 ultra wallet case` was served as 143 POCO items: phones,
tablets, 1 tablet case and 2 shipping-fee links, but no phone case. 139 of
the titles hold the brand word `poco`, and the share was 0.979. `type c
iem` was served as 49 items, mostly USB-C cables and chargers, and no IEM.
The word `type` was in 86% of those titles. Both ended
`exhausted-all-results`. Two narrow rules catch this now. Both make the
verdict `off-query`:

- `off-query-connector`: the query holds a connector word (`type`, `usb`, `lightning`, `thunderbolt`, `hdmi`, `magsafe`).
  A query's `usbc` or `typec` is read as two words. A connector word is
  in half the titles or more, and every other keyword is in fewer than
  15% of them. A plug is on cables, chargers, hubs and flash drives
  alike, so it cannot show that the product is there. For this rule only,
  a title that names the same goods in other words counts: `Cord` or
  `Lead` for `cable`, `Earbuds` for `earpods`, `Hub` for `dongle`.
  A query whose other words are all specs with a digit (`usb c 2m`,
  `type c 120w`) is not warned when 60% of the titles or more are
  cables, chargers or adapters: those are its product.
- `off-query-keywords`: the share passed, but 3 or more keywords, and
  more than half of them, are each in fewer than 5% of the titles (`f7`,
  `wallet`, `case` for the phones). Connector words are not counted
  here. A brand or model word cannot be listed, so the rule counts what
  is missing. `dupe` is not a keyword: sellers never write it.

`relevance.missingKeywords` names the counted keywords under 5% of the
titles. `relevance.connectorKeywords` names the connector words. On
`off-query-connector`, `relevance.offSample` holds titles that hold no
other keyword. On `off-query-keywords` it holds titles that lack every
missing keyword. Treat both like any `off-query`: read those titles
first.

How the rules were chosen. Variants were scored on labelled streams: real
harvests and their page cuts, live captures of 2026-10-19 and synthetic
sets. Two reviews then ran the real code. On the real and live correct
streams the rules raise no warning that the old rule did not. They lose
no catch of the old rule, and they catch 11 more off streams. A UK form
also gives its US form (`aluminium`, `Organisers`, `adaptor`), and
`magnetic` gives `magnet`.

Costs, measured on correct streams written to break the rules (43 new
warnings in 945 correct streams):

- a connector query with no noun, only an attribute: `usb c braided`,
  `usb c angled`, `usb c long`.
- a spec written apart from the titles: `usb c 3 meter` over titles that
  say `3M`, `usb c to 3.5 mm` over `3.5mm`.
- a brand, model and size query over a generic or look-alike stream:
  `crucial p3 plus 1tb` over plain SSDs. Here the warning is mostly
  right: the brand is not there.
- attribute words sellers do not use: `whisper quiet cordless mouse`
  over silent wireless mice.

Still not seen:

- a stream that lacks only 1 or 2 query words. `iphone 15 case` served
  as iPhones lacks 1 of 3. The real POCO phones pass for `poco wallet
  case` and `poco f7 case` (2 missing each).
- a device query served as its accessories: `canon eos r50` over camera
  straps and filters.
- a connector word that no title holds: `lightning earphones` over USB-C
  earphones.

`pages[].onQuery` and `status().relevance.share` show only the share
rule, not the two rules above. `extract.js` output has no query, so no
rule runs on the single-page fallback. `decode.mjs` passes a single
payload through as it is; `rank.mjs` re-checks it.

The rule is loose on purpose: a stricter
"head word" rule raised false alarms on correct streams ("mouse wired",
"rc car", "coil spring"), and a false alarm throws a good harvest away. So
an off stream that shares one keyword passes (craft wire for `wire brush
set`), and so does one whose title words join into a keyword (`Car Pet
Seat Cover` for `carpet`): read `relevance.keywordShare`, and when the
noun's share is low, look at a few titles. Titles in Hebrew, and Latin-script titles in another
language (Spanish, German, French), cannot be compared with English
keywords. Their function words give them away. `und`, `mit`, `für`,
`avec`, `sans`, `por`, `une`, `della`, `voor` and `och` count alone.
`para`, `con`, `pour`, `les`, `des` and `sin` are English words too (`Pour
Over Kettle`, `Les Paul`), so one of them counts only beside a second one
or a letter with an accent. When more than half of the titles are not in
Latin script, or 3 in 10 look foreign, `relevance.measured` is `false`
(`titles-not-latin` / `titles-not-english`), so check a few titles yourself. `pages[].onQuery` gives the share per page, which shows
where deep drift begins.

### Single-page fallback

`scripts/extract.js` still reads the **currently loaded** page and is the right
tool when you only need what is on screen, or when `harvest.js` cannot fetch. It
reads `window._dida_config_._init_data_` first (~60 structured records) and
falls back to DOM cards.

Its return value is the whole result as one JSON string, about 20,000
characters for 60 items. The in-app browser reads it whole. **The Chrome
connector cuts it at 1,000 characters**, so the result also stays on
`window.__aeExtract`. In Chrome, return pieces of it instead:

```js
[__aeExtract.result.source, __aeExtract.result.cardCount, __aeExtract.result.withRating,
 __aeExtract.result.blocked, __aeExtract.result.suspectedWall, __aeExtract.result.visibility]
JSON.stringify(__aeExtract.result.items.slice(0, 2))   // a look at two items
__aeExtract.send(8765)   // all of it to receiver.mjs, after: curl -s http://127.0.0.1:8765/
```

`__aeExtract.send(8765)` is the same form POST as `__aeHarvest.send(8765,
{via: 'form'})`, so it navigates, to a dead port too: run the curl check
first. Its reply starts with `UNCONFIRMED`; only `saved <path>` in the
receiver's own output means the file exists. The saved file goes to
`rank.mjs` as it is. If the receiver printed nothing, navigate back to the
search page and run `extract.js` again: the items are on the page.

With the Browser pane hidden the results container renders at `clientHeight: 0`,
`IntersectionObserver` never fires, lazy loading stalls, and the DOM yields ~13
cards while the embedded JSON on the *same page* holds 60. Scrolling cannot fix
this. `__INIT_DATA__` really is undefined and `runParams` really is empty,
whatever scraping blogs claim — but `_dida_config_._init_data_` is not.

### Getting a large payload out of the browser

A full harvest is ~200 KB per 400 items (about 500 chars per item, measured on the 2026-10-17 harvests). **Primary channel, both browsers:**
the page POSTs it to a loopback receiver that writes the file. Start the
receiver as a background Bash task *before* the harvest so the harness
tracks it:

```bash
node ~/.claude/skills/aliexpress-finder/scripts/receiver.mjs --dir <scratchpad> --port 8765
```

It takes any number of payloads and exits after 60 minutes without a
request to it (`--count N` / `--idle S` change that). A flag with no value,
an empty `--dir`, an unknown flag or a stray word exits 2 with a message.
So `--dir $OUT` with OUT unset is refused. Until 2026-10-19 it saved into a
directory named `--port`, or into the cwd, with exit 0. The harvest's own
fetches go to AliExpress and do **not** reset that timer, so before every
`send()` check it is up: `curl -s http://127.0.0.1:8765/` answers
`ok <n> saved, …`. (Until 2026-10-18 it exited after ONE payload or 15
idle minutes. The hidden-tab recovery needs two sends, and the second one
met a closed port.)

then in the browser:

**In both browsers use `send(8765, {via: 'form'})`, after the curl
check.** Measured 2026-10-18 in both:

- In-app browser (Chromium 152): every `fetch()` from an https page to
  loopback is refused by the browser itself (`net::ERR_BLOCKED_BY_CLIENT`).
- Signed-in Chrome (connector): a plain `send(8766)` answered `NOT
  DELIVERED: FETCH-ERROR TypeError: Failed to fetch` twice, while `curl`
  showed the receiver up and the receiver logged nothing. No CSP violation
  fired. `send(8766, {via: 'form'})` then arrived (`saved <path>`, 92
  items). Chrome 153 used to HOLD such a fetch instead (2026-09-14), so
  either can happen.

So a plain `send(8765)` normally answers `NOT DELIVERED: FETCH-ERROR` in
both browsers, receiver up or not. It does not navigate, but it never
delivers there. `{via: 'form'}` never tries the fetch. It saves the
harvest to `localStorage` (one key per run; the 3 runs
saved last are kept), then submits a top-level `text/plain` form to the
receiver. **A form POST always navigates, to a dead port too.** So the
curl check before `send()` is the guard against a dead port, and
`restore()` is the way back.

```js
await __aeHarvest.send(8765, {via: 'form'})   // both browsers, after: curl -s http://127.0.0.1:8765/
// visible tab: "UNCONFIRMED: form-posted 91234 chars to http://127.0.0.1:8765/harvest; backup saved (400 items)
//               - delivered only if the receiver prints "saved <path>" in its own output: read it there, …"
// hidden tab:  "UNCONFIRMED: form-posted … (tab hidden: fetch skipped); backup saved (400 items) - …"
// no backup:   "NOT DELIVERED: no form posted, because the localStorage backup failed (…)" (nothing navigated)
// the receiver's own output (the background task), when it arrived: "saved <dir>/harvest-<query>-<stamp>.json"
```

The reply starts with the outcome. With `{via: 'form'}` it is
`UNCONFIRMED` whenever the form was posted. **Only `saved <path>` in the
receiver's own output means the file exists.** Read it from the background
task, which works whether or not the tab is visible. Then `navigate` back
to AliExpress. Window state is gone after that navigation, but the backup
is not. If the receiver printed nothing (it was down, so the tab went to
an error page), start it, install `harvest.js` again, call
`__aeHarvest.restore()` and send again. Nothing is retyped and nothing is
chunked. If the backup cannot be written, no form is posted unless you
pass `{force: true}`.

**A plain `send(8765)`** (no `via`) tries a `fetch()` POST first, and only
then are the replies different:

- `DELIVERED: sent 91234 chars; receiver replied 200: saved <path> (…)`:
  the fetch got through. Only `DELIVERED`, or `saved <path>` in the
  receiver's output, means the file exists.
- `NOT DELIVERED: FETCH-ERROR … The page did NOT navigate: the harvest is
  still here. …`: the fetch was refused (nothing listening, or a browser
  that blocks loopback). Check the receiver with curl. If it is down, start
  it and send again. If it is up, use `{via: 'form'}`.
- `UNCONFIRMED: form-posted … (fetch held 3000 ms); backup saved …`:
  Chrome held the fetch (its local-network permission gate held such a
  request for 45 s without it ever reaching the receiver, measured on
  Chrome 153), so `send()` saved the backup and posted the form.

In a **hidden** tab a plain `send()` skips the fetch and posts the form at
once, because the fetch race needs a timer (see "A hidden tab").
`send(8765, {via: 'fetch'})` never posts the form: when the fetch is
still pending it answers `UNCONFIRMED: FETCH-HELD`, and it may still
arrive, so read the receiver output before sending again.

The receiver writes `harvest-<query>-<stamp>.json` in `--dir` and prints
that path (a `-2`, `-3` suffix when two arrive in the same millisecond; a
write error answers 500 and the receiver stays up). The commands below call the file `harvest.json`: copy the printed
path to it, or pass the printed path instead.

**Fallbacks**, decoded by the one decoder:

```bash
node ~/.claude/skills/aliexpress-finder/scripts/decode.mjs <file...> > harvest.json
node ~/.claude/skills/aliexpress-finder/scripts/decode.mjs --check <file...>   # coverage only
```

Several payloads in one call are **merged**, never dropped (until 2026-10-18
the decoder kept the first and dropped the rest with exit 0): items deduped
by id, `parts` per input (a merged file can be merged again), and the
verdict worked out per search stream (query, `fourStar`, `extra`):
`exhausted-all-results` only when a part ran dry at page P, pages 1..P were
all read, and no part read items past P (`stream-changed` otherwise). A
payload from a harvest.js older than `filterKey` that used an extra filter
is a stream of its own. Its key comes from its content, so it joins no
other part, in a merge or in a merge of merged files. (Until 2026-10-19 the
key was its position in the call, so a re-merge could join two streams and
call them `exhausted-all-results`.) A part
whose titles do not match its query makes the merge `off-query`, even from
an old harvest.js. A merged file keeps its parts' verdicts as they were
written: after `decode.mjs` changes, merge again from the original payloads. A JSON array of payloads is accepted too. A dump whose
`AEPAYLOAD … START` has no matching `END` (cut, or saved with CRLF and
then changed) is an error, never a silent drop.

- *In-app browser:* call `__aeHarvest.payload()`. The result exceeds the
  tool-result limit, the harness saves it to a file and prints the path —
  that file is the input to `decode.mjs` (double-encoded: a JSON array whose
  `text` field holds a JSON string; the decoder knows).
- *Chrome connector, visible tab only* (`get_page_text` hangs on a hidden
  one): `payload()` would come back as 1,000 characters plus
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
The `harvest.js` envelope is consumed directly. For every payload that names
its query, `rank.mjs` repeats the off-query warning (`off-query-results`,
`off-query-connector` or `off-query-keywords`, step 3) when the titles do not
match it. On a merge of different queries it checks the joined pool with
the share rule only, and repeats each part's own warning. A bad flag value (`--top abc`, a bare
`--spread`, a blank `--min-evidence ''`) and an unknown flag (`--constriant`)
are errors, exit 2, never an empty list or a dropped requirement. So are a
flag with one hyphen (`-constraint`), in upper case (`--Constraint`) or with
an em dash from autocorrect in place of `--`, a stray word, a blank
`--require ''` and a `--require` regex that does not compile. Until
2026-10-19 the first four were skipped with exit 0.
`--name=value` works as well as `--name value`.

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
like "milk frother containeraliexpress milk frother…", all fields null).
In `final` mode no finalist is dropped as junk: see step 7. The 4★
URL filter from step 1 already removes nearly all of these upstream.

Expect **ties**. Sold is bucketed ("10,000+", "50,000+", "100K+"), so top
candidates score identically. That is exactly why step 5 exists. When a tie
crosses the `--top` cut, the items that get in are chosen by input order;
`rank.mjs` names that in a `tie-at-cutoff` warning with the tied ids it left
out. Raise `--top` to fetch them too, or say the shortlist split a tie.

**A sold text the parser cannot read is set aside, never judged.** `rank.mjs`
drops such an item as `sold-unparsed` and names the text in a warning. On
2026-09-25 "100K+ sold" was unreadable, and the two best sellers of a
1,228-item pool were dropped as `evidence<100` with no warning. If the warning
fires, fix `parseSold`/`SOLD_RE` or open those items' detail pages.

## Step 5 — Fetch exact review counts (mandatory)

Sold counts are bucketed ("1,000+", "5,000+", "10,000+", "50,000+", "100K+").
The only fine-grained signal is the listing's own rating count on the detail
page. It is NOT the JSON-LD `reviewCount`: that number is usually pooled across
other sellers' similar items (see the reader below).

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
node ~/.claude/skills/aliexpress-finder/scripts/rank.mjs --mode shortlist --top 10 --spread 4 < harvest.json
```

`--spread K` reserves K of the `--top N` slots (the output stays N items, N-K
of them by score) for a stratified sample across sold
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

For each selected item, navigate to its URL, scroll to the middle of the page,
wait 2-3 s with `computer{action:"wait"}` (the review block renders late;
never wait with a timer inside the page), and run the reader below. Its
output stays under the Chrome connector's 1,000-character limit. `test.mjs`
pulls this code out of this file and runs it against sample pages, so edit it
here, between the markers, and run the tests after any change.

<!-- @snippet:step5:start -->
```js
(() => {
  /* @shared:soldRe:start */
  const SOLD_RE = /([\d.,]+\s*[KkMm]?\s*\+?)\s*(?:נמכר|sold)/i;
  /* @shared:soldRe:end */
  /* @shared:reviewBlock:start */
  function parseReviewBlock(text) {
    const t = String(text || '').replace(/\s+/g, ' ');
    const num = (s) => Number(String(s).replace(/[.,](?=\d{3}(?:\D|$))/g, ''));
    const blk = t.match(/(\d\.\d)\s+(\d[\d,.]*)\s+ratings?\b(?=\s*All from verified)/i) ||
                t.match(/(\d\.\d)\s+(\d[\d,.]*)\s+ratings?\b/i);
    const head = t.match(/Reviews\s*\((\d[\d,.]*)\)/i) || t.match(/(\d[\d,.]*)\s+Reviews\b/i);
    const own = blk ? num(blk[2]) : null;
    const header = head ? num(head[1]) : null;
    return {
      own: Number.isFinite(own) ? own : null,
      ownRating: blk ? Number(blk[1]) : null,
      header: Number.isFinite(header) ? header : null,
      pooledNote: /from various sellers for similar items/i.test(t),
    };
  }
  /* @shared:reviewBlock:end */
  const path = location.pathname;
  const tx = ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ');
  if (/_____tmd_____/.test(path) || /Captcha/i.test(document.title || '') ||
      /slide to verify|unusual traffic/i.test(tx)) throw new Error('WALL: stop and tell the user (step 2)');
  let p = null;
  for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { const a = JSON.parse(el.textContent); p = p || (Array.isArray(a) ? a : [a]).find((x) => x && x['@type'] === 'Product'); } catch (e) {}
  }
  if (!p) return JSON.stringify({ error: 'no JSON-LD: take a SCREENSHOT before concluding anything', path, bodyLen: tx.length });
  const o = p.offers || {}, ar = p.aggregateRating || {}, rv = parseReviewBlock(tx);
  // The header may hold one separator mark between "Reviews" and the count,
  // never a digit: "\S?" took the first digit ("10,000+" read as "0,000+").
  // A comma or a dot may be that mark ("Reviews, 10,000+ sold").
  // Live 2026-10-19 the header also said "Reviews ౹ 10,000+ sales ౹ 10,000+
  // cross-platform sales". Only the header counts: the page also holds
  // other products' cards ("4.9202 sold" is a 4.9 rating next to 202 sold),
  // so there is no page-wide fallback. No header count: soldRaw is null.
  const HEAD = new RegExp('(?:Reviews|חוות דעת)\\s*(?:[^\\s\\d]\\s*)?' +
    SOLD_RE.source.replace('(?:נמכר|sold)', '(?:נמכר|sold|sales)'), 'i');
  const sold = tx.match(HEAD);
  // Spec rows a hard requirement is decided on. Edit WANT per requirement.
  const WANT = ['Type', 'Interface Type', 'Power Type', 'Power Source', 'Battery Included'];
  // A trailing colon ("Type:") is not part of the name, as in listing.js.
  const want = (k) => WANT.find((w) => w.toLowerCase() === String(k || '').trim().replace(/[:：]$/, '').trim().toLowerCase());
  const spec = {}, opts = [];
  // The table shows about 6 rows until its "View more" button is clicked.
  // Measured live 2026-10-19: 6 rows, then 15 in the same call, and the
  // button is gone after the click. So click it first, then read.
  let specMore = 0;
  const more = (r) => { for (const e of r.querySelectorAll('*')) {
    if (/specification--btn/.test(String(e.className || '')) && typeof e.click === 'function') {
      try { e.click(); specMore++; } catch (x) {}
    }
    if (e.shadowRoot) more(e.shadowRoot);
  } };
  more(document);
  const walk = (r) => { for (const e of r.querySelectorAll('*')) {
    const c = String(e.className || '');
    if (/sku-item--(image|text)|sku-property-item/.test(c)) {
      const im = e.querySelector && e.querySelector('img');
      opts.push(((im && (im.getAttribute('alt') || im.getAttribute('title'))) || e.textContent || '').replace(/\s+/g, ' ').trim() + (/selected/.test(c) ? '*' : ''));
    }
    if (/specification--prop/.test(c) && e.querySelector) {
      const k = e.querySelector('[class*="specification--title"]'), v = e.querySelector('[class*="specification--desc"]');
      const w = k && want(k.textContent);
      if (w && v) spec[w] = v.textContent.replace(/\s+/g, ' ').trim().slice(0, 40);
    }
    if (e.shadowRoot) walk(e.shadowRoot);
  } };
  walk(document);
  let specFrom = Object.keys(spec).length ? 'dom' : 'none';
  if (specFrom === 'none') {
    const ls = ((document.body && document.body.innerText) || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
    // Every "Specifications" line (the first may be a tab label); the scan
    // stops at the next section heading; the richest block wins.
    // The same section ends as listing.js SPEC_END (test.mjs checks it).
    const END = /^(description|report item|more to love|store|reviews?|customer reviews|you may also like|תיאור|ביקורות|חנות)\s*(\(\d[\d,.]*\))?$/i;
    let best = {};
    ls.forEach((l, at) => {
      if (!/^specifications$/i.test(l)) return;
      const got = {};
      for (let i = at + 1; i + 1 < ls.length && i < at + 120 && !END.test(ls[i]); i++) {
        const w = want(ls[i]); if (!w || w in got) continue;
        // A wanted name right after it, then a value: this row's value is empty.
        got[w] = END.test(ls[i + 1]) || (want(ls[i + 1]) && ls[i + 2] != null && !want(ls[i + 2])) ? '' : ls[i + 1].slice(0, 40);
      }
      if (Object.keys(got).length > Object.keys(best).length) best = got;
    });
    Object.assign(spec, best);
    if (Object.keys(spec).length) specFrom = 'text';
  }
  // Deduped on the WHOLE name, then shortened keeping both ends, so
  // "Bluetooth Rechargeable Black" and "... Grey" stay two options.
  const short = (x) => (x.length > 24 ? x.slice(0, 13) + '…' + x.slice(-10) : x);
  const uo = [...new Set(opts)], shown = uo.slice(0, 10);
  for (const x of uo) if (/\*$/.test(x) && !shown.includes(x)) shown.push(x);
  const out = { id: (path.match(/(\d+)\.html/) || [])[1],
    rating: ar.ratingValue != null ? Number(ar.ratingValue) : null,
    reviews: rv.own, ownRating: rv.ownRating,
    pooledReviews: ar.reviewCount != null ? Number(ar.reviewCount) : null, pooledNote: rv.pooledNote,
    price: o.price != null ? Number(o.price) : null, currency: o.priceCurrency || null,
    soldRaw: sold ? sold[1].replace(/\s/g, '') : null, soldFrom: sold ? 'header' : 'none', spec, specFrom, specMore, optionCount: uo.length, options: shown.map(short) };
  // Never past the connector's 1,000 characters: options go first, named.
  let s = JSON.stringify(out);
  // Unselected ones are cut first, from the end: the selected ones name the
  // option the price is for, so they go last.
  while (s.length > 990 && out.options.length) {
    let i = out.options.length - 1;
    for (let j = i; j >= 0; j--) if (!/\*$/.test(out.options[j])) { i = j; break; }
    out.options.splice(i, 1); out.optionsCut = true; s = JSON.stringify(out);
  }
  return s;
})()
```
<!-- @snippet:step5:end -->

What comes back, and why each field is there (all measured 2026-09-25):

- **`reviews` is the listing's own rating count**, read from the review block
  ("4.9 1090 ratings"). `pooledReviews` is the JSON-LD `reviewCount`. It equals
  the header "N Reviews" and the "Reviews (N)" tab, and on most listings it is
  pooled across similar items from other sellers. The page says so:
  "Reviews displayed are from various sellers for similar items"
  (`pooledNote: true`). Header vs own: 5,479 vs 1,090, 9,460 vs 1,914,
  4,779 vs 488. On the one listing without that note the two were equal
  (37 vs 37). **Rank on `reviews`, and report both numbers.** That `reviews` is
  the own count is read from the page, not from any AliExpress documentation.
- **`ownRating` is the listing's own rating**, from the same review block.
  `rating` is the JSON-LD `ratingValue`. It comes with the pooled
  `reviewCount`, so treat it as pooled too (inferred, not measured). On
  the pages copied on 2026-09-25 the two ratings match: the 1,090-rating
  listing reads "4.9 5479 Reviews" in the header and "4.9 1090 ratings" in
  the block. A listing whose own buyers rate it lower than the pool has
  not been seen live yet. `test.mjs` checks the ranking on a made-up one
  (pooled 4.9, own 4.1). Pass `ownRating` to
  step 7 (`rank.mjs --mode final` ranks on it when it is there) and report
  it in the table, not the pooled `rating`.
- **`reviews: null` means unknown**, for example on a Hebrew page, where the
  wording of the review block has not been observed yet. Never put the pooled
  number in its place. `rank.mjs` sets such a finalist aside as
  `own-reviews-unknown`, also when it carries no pooled count either.
- **`soldRaw`** comes from the header only ("... Reviews 100K+ sold" or
  "... Reviews ౹ 10,000+ sales"), and `soldFrom` says `header` or `none`.
  From 100,000 up it carries a K. "Cross-platform sales" is not this
  listing's count and is never read. With no header count, `soldRaw` is
  `null`: then use the search grid's `soldRaw` for that item. Until
  2026-10-19 the reader fell back to the first "sold" on the page. On a
  live page whose header said "sales", that was a related item's card,
  "4.9202 sold" (a 4.9 rating next to 202 sold), and it was returned as
  this listing's count.
- **`options`** are the listing's own options, read from the option selector;
  `*` marks the selected one, one per option property (Color AND Type). The
  first 10 come back, plus every selected one past them; `optionCount` is the
  total. The JSON-LD `price` is the selected options' price, so say which
  they are. A "$2.14 keychain" was the 1-key option, not the 9-key pad in its
  title. When the output would pass 1,000 characters, options are cut and
  `optionsCut` is `true`. Unselected ones go first. A selected one is cut
  only when no unselected one is left.
- **`spec`** holds the Specifications rows named in `WANT` (default `Type`,
  `Interface Type`, `Power Type`, `Power Source`, `Battery Included`; edit `WANT` to match
  the user's hard requirements), and `specFrom` says where they came from:
  `dom` (the `specification--prop` rows), `text` (the lines after a
  "Specifications" heading) or `none`. The reader clicks the Specifications table's
  "View more" button first (class `specification--btn`); `specMore` says
  how many it clicked. Measured live on 2026-10-19: the table showed 6
  rows, and `Type: Bluetooth Wireless` appeared only after that click (15
  rows, in the same call; the button is then gone, so a second run is
  safe). Before this, the reader returned only `Power Type`, and a
  "wireless" requirement looked unknown on pages that stated it. The class names
  (`specification--prop`, `--title`, `--desc`) were measured on a live page
  on 2026-10-18 in signed-in Chrome: the `dom` path read the rows. Trust a
  `dom` row. The `text` line layout is not measured live yet. It stops at
  the same section headings as `listing.js`, and a name may end in a colon
  (`Type:`). `specFrom: 'none'` means
  unknown, never "not stated": then read the rows with `listing.js`
  (`__r.specs`, `__r.specsText`) or a screenshot before setting a
  constraint. `listing.js` reads the text path by spec NAME (`specsSource:
  'text'`, with a `specs-from-text` warning: confirm the row in `specsText`
  before a constraint rests on it); a table with no known name (a Hebrew
  one) comes back as `specsSource: 'text-raw'` with only `specsText`.
- Brand is not here. It comes from step 6.

### Read the whole listing — both channels, one call

The step-5 reader gives review counts, price, sold and options only. For anything physical — ratings, current,
dimensions, what is on the output — install `scripts/listing.js` and run:

```js
window.__r = await __aeListing.read()   // async since 2026-09-29: top-level await
[__r.blocked, __r.suspectedWall, __r.warnings]  // read `blocked` / `suspectedWall` first, then warnings
```

It expands every "show more" first (and the Specifications table's own
"View more", by its class, reported as `specExpanded`), then returns **text and images together**:
`sizeLines`, `ratingLines`, `variants`, `selectedVariant` (the first) and
`selectedVariants` (one per option property), `specs` / `specsSource` (the
whole Specifications table), `reviews`, `gallery`, `descriptionImages`,
`description`, `text`, `textCut`, `visibility`, `warnings`, plus a
`fingerprint`. One call, both channels, deliberately —
see the defect below. In Chrome the whole result is far over 1,000
characters: keep it on `window` and return the fields you need in pieces.

- **`gallery` is the product's own photos only**, full size, in slider order.
  Other products on the page (related items, the footer licence badge, menu
  icons) are counted in `excludedImages` and never returned as the product.
  `galleryScope: 'unscoped'` means the product container was not found and
  the old "every big image" list came back instead, with a warning: then
  check every image before trusting it.
- **The description is read** (`description.source`): `rendered` from its
  shadow tree under `#nav-description`, or `fetched` from the URL the page
  already requested when nothing is rendered (a hidden tab never renders
  it). Its text is appended to
  `text` after `[DESCRIPTION]` and feeds `sizeLines`; its images are
  `descriptionImages`, where dimension drawings usually are. `missing`,
  `fetch-failed` (also an HTTP error such as a 403 token page, or a JSON
  reply with no images, such as `{"code":"TOKEN_EXPIRED"}`),
  `skipped` or `pending` means **unknown**: never write "the
  listing does not state the size" from that. When `text` passes `maxText`
  (20,000), the PAGE text is cut first so the description stays, and
  `textCut` plus a `text-cut` warning say how much was kept. `blocked` or `suspect-wall`
  means a **wall answered the description fetch**: the top-level `blocked` /
  `suspectedWall` is set, and it is the same STOP as step 2.
- **A stalled description fetch does not lose the read.** `read()` stores a
  complete result without the description in `__aeListing.last`
  (`description.source: 'pending'`) before it fetches. If `read()` times out,
  return fields from `__aeListing.last` in the next call; it is replaced when
  the fetch settles. `await __aeListing.read({ description: false })` never
  fetches.

Five things it encodes that cost real time to discover:

- **Options come only from the option selector** (`sku-item--image`,
  `sku-item--text`; the selected one also carries `sku-item--selected`). It
  used to read any element whose class mentioned "sku", which returned the
  variant lines of reviews, often of other sellers' items, and missed every
  image option.

- **`document.querySelectorAll('img')` returns ONE image on a detail page** (a
  240x240 icon) while dozens are displayed. The gallery lives behind a shadow
  root; a shadow-DOM walk finds ~74. `_dida_config_._init_data_` is **empty**
  on detail pages (length 2) — it only carries data on search pages. Every
  collector in `listing.js` recurses through `shadowRoot`.
- **Any mutation invalidates your previous read.** Expanding a description or
  selecting a variant changes the DOM. `changed(fp)` tells you whether a
  re-read is owed. If you clicked anything, you owe one.
- **A "size" line may be the shipping box.** `isPackage: true` marks it, and
  `productSizeLines` / `packageSizeLines` keep them apart. `12 x 7 x 4 cm /
  59 g` was the carton; the product was `8 x 3.7 x 2 cm`. A labelled line
  ("Size: …", "Package size: …") is judged on its own words; a bare size
  takes its qualifier from the text just before it. (The whole parent text
  used to decide, so `Size: 22 x 12 x 28 cm` in a list that also said
  "Package includes" was marked as the carton.) A line with a bold label,
  `<li><b>Size:</b> 22 x 12 x 28 cm</li>`, is read as one line. A line that
  holds two sizes splits where the second label starts: `Size: 10 x 5 x 3 cm
  Package size: 12 x 7 x 4 cm` gives one product size and one carton.
  "Box" is the carton only when it is said as packaging: `Box size`, `Gift
  box`, `Outer box`. `Lunch Box Size: 20 x 15 x 6 cm` is the product's own
  size, because the product is a box. The product title decides first:
  when the page title holds no "box" (or קופס), every box size is the
  carton, so `White box size` on a mouse page is the carton. Packaging
  words before "box" (`White`, `Single`, `Display`, `Master`) and a word
  glued after another label (`Material: ABS Box size:`) also mean the
  carton. Known limits: a bare `Box size:` on a box product is still
  called the carton, and with no page title the word before "box" decides
  alone. So read the title first.
- **The description lives in a shadow root, and `innerText` never sees
  shadow content.** `text` used to be `body.innerText`, so "Weight: about
  750 g" was on screen and absent from `text` (2026-09-29). The description
  is now read from its shadow tree, `<style>` skipped. The iframe under
  `#nav-description` is empty in both tab states: it is not the description.

Then read the labels — this is not optional for hardware. Pass `gallery`
AND `descriptionImages`:

```bash
~/.claude/skills/aliexpress-finder/scripts/labels.sh fetch /tmp/labels <url1> <url2> ...
```

Downloads are **WebP even when the URL ends in .jpg**, so the script converts
to PNG (`sips`; PIL is not installed here). If the case text is too small to
read in the 800x800 shot — and it usually is — crop and upscale:

```bash
~/.claude/skills/aliexpress-finder/scripts/labels.sh crop /tmp/labels/img1.png 295 328 150 175
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

**The scale, and the rule that keeps it honest:** 0.5 is "no evidence either
way". **A score below 0.5 needs evidence of a problem** (specs or price the
brand cannot back, impersonation, bad independent reviews), named in the
reason. A score above 0.5 needs independent evidence of a good reputation.
So an unknown house brand that does not impersonate anyone and has nothing
against it scores **0.5**, the same as a brandless listing.

**Branded → research each distinct brand** for both:

1. **Plausibility.** Are these specs and this price credible for this brand? A
   real brand name on AliExpress does not mean a genuine product. Check claimed
   capacity/wattage against the brand's actual product line, and the price
   against real retail. *Worked example:* HiBREW M1A listed ₪133.56 ≈ €33, and
   EU retail is €39 with matching 450W specs — just under retail, which is
   normal for direct-from-China and **not** the impossible-price fake pattern.
2. **Reputation.** What do independent reviews say about the brand here?

Produce `brandScore` 0..1 and a one-line reason. Pass it as a number.
`rank.mjs` reads a number in a string (`"0.05"`), and sets aside an item
whose score is not a number or is outside 0..1, with a warning. (Until
2026-10-19 a string was read as no brand data, so a counterfeit lost its
demotion, and an 8 on a 0..10 scale ranked first.) Score a counterfeit-implausible
listing near 0 so it cannot be promoted. Score an unknown-but-not-impersonating
house brand **0.5**: unsupported is not the same as fraudulent. (This file
used to say ~0.35 for it. With identical evidence that ranked a researched
house brand BELOW an unresearched or brandless listing, so doing step 6 cost
a listing score and skipping it paid; measured 2026-10-18.)

Use parallel subagents (one per brand) when the environment allows it; otherwise
do the research inline with web search. Either satisfies this step.

**This is the trap the whole step exists for:** a naive "prefer known brands"
rule promotes counterfeits, because the fakes wear the strongest brand names.

## Step 7 — Final rank

Add `reviews` and `ownRating` (the listing's OWN count and rating from the
step-5 reader), `pooledReviews`, `soldRaw`, any `brandScore`, and a
`constraints` status per hard requirement to each finalist, then pass every
requirement as `--constraint`. Never copy the pooled count into `reviews`.
A finalist with `reviews: null` is set aside as `own-reviews-unknown` and
named in a warning, also when it has no rating at all; re-read its review
block. A finalist with an own count but no rating is set aside with a
`no-rating` warning. (Until 2026-10-19 a finalist with no rating and no
counts was dropped as `no rating`, the SEO-junk reason, with no warning.) In `final` mode the rank uses
`ownRating` when it is there; a finalist without it but with a pooled count
that differs from its own is flagged `rating-may-be-pooled`.

**Set each constraint from the spec rows, never from the title alone:**

1. `pass` needs a positive statement in a spec row (step-5 `spec`, or
   `listing.js` `specs`), the description, or the product photo. A title
   "Wired" with a spec row `Type: 2.4Ghz Wireless`, `Power Type:
   Rechargeable` or `Power Source: Rechargeable` is a `fail`: say the two disagree.
2. `fail` needs a statement that contradicts the requirement.
3. Anything else is `unknown`, including `specFrom: 'none'` and a
   description that was not read. `unknown` is held out of `ranked`.

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

Table of the 4: title, detail price (in the currency the account shows),
OWN rating (`ownRating`), OWN rating count, sold, brand verdict, link. Say once that the header
count on the page is pooled across other sellers, with one example pair. Then,
briefly:

- **the hard requirements, and that every listed item passes them.** If any
  item in the table fails one, it does not belong in the table. If `ranked` is
  empty, read `note`: only "no candidate satisfies the stated constraints"
  means that nothing satisfies the requirement — then say so plainly, it is
  the answer, not a reason to substitute something else. "no candidate is
  VERIFIED" means the items are unchecked, not failing.
- **anything in `unverified`** — named, with what is unchecked about it. Never
  present an unverified item as satisfying a requirement.
- **which specs came from the product photo** rather than a text field, and any
  place where the two disagree. The photo wins; say so.
- **dimensions**, and whether the figure is the product or the shipping carton.
- why each won (cite the actual numbers)
- **coverage, honestly**: whether the harvest was `exhausted-all-results`,
  `truncated` or `off-query`, how many unique items and how many pages. Never
  a percentage of `totalResults`.
- which product class was ranked, and what was excluded
- that step-5 detail fetches were a spread (`--spread`), which tiers it reached,
  and that stratification samples the range rather than proving one winner
- any `flags` raised (`extreme-discount`, `price-outlier-low`, `sold-saturated`
  (a bucketed sold of 10,000+), `reviews-exceed-sold` (only against an exact
  sold count, not a "1,000+" floor), `few-reviews-for-sales` (reviews under
  2% of a sold count of 1,000 or more), `brand-unresearched`, `brand-implausible`
  (a `brandScore` under 0.2: the brand weight can only demote it a little,
  so say it is likely a counterfeit), `rating-may-be-pooled`), and any
  `sold-unparsed`, `own-reviews-unknown`, `no-rating`,
  `brandScore-out-of-range`, `not-a-number`, `off-query-results`,
  `off-query-connector`, `off-query-keywords`,
  `tie-at-cutoff`, `tie-in-spread`, `unverified-only` or `empty-input`
  warning, with the items it names
- which option the detail price belongs to (the selected one in `options`)
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
| `scripts/harvest.js` | **Primary.** Browser-side paged harvester: resumable, block-aware, reads until an empty page or a page with no new ids (never on `finished`), reports `coverage.verdict`, `endSignal`, `relevance` (off-query streams) and `visibility`. Runs unchanged in both browsers; `forceEnglish()` (in-app only), `send()` (outcome-first reply; `send(port, {via: 'form'})` always posts the form, so it navigates even to a dead port: curl the receiver first; a plain `send()` never navigates after a refused fetch; a backup is saved before any form POST; the fetch race is skipped in a hidden tab), `restore()`/`backups()`/`dropBackup()` (localStorage backup per page, the run saved last first), `resume()` (clears a stop, keeps the items), `startPage`, `maxPages` capped at the site's last page (60), one `step()` loop at a time (`running` in `status()`), `expose()`/`chunks()` (Chrome export, visible tab only), `debugUrl()` (in-app only). |
| `scripts/receiver.mjs` | **Primary export.** Loopback HTTP receiver; after a `curl` check, `__aeHarvest.send(port, {via: 'form'})` POSTs the payload to it and it writes `harvest-<query>-<stamp>.json` and prints `saved <path>` in its own output (a fetch gets the same line as its reply). No payload limit by default; exits after 60 idle minutes; `GET /` answers `ok …`. |
| `scripts/decode.mjs` | **Fallback decoder and merger.** Reassembles a payload from the in-app harness file (double-encoded), from Chrome `get_page_text` chunk dumps (any order, refuses a partial set), or from a plain payload JSON or an array of them. Several payloads are merged, deduped by id, never dropped. |
| `scripts/build.mjs` | Writes `scripts/dist/*.min.js`: the three browser files without comments, for the install paste. `--check` reports a stale copy; `test.mjs` fails on one. |
| `scripts/dist/*.min.js` | Generated install copies. Never edit them; edit the source and run `build.mjs`. |
| `scripts/extract.js` | Single-page extractor for the currently loaded page. `_init_data_` first, DOM fallback, reports `source`, `blocked` and `visibility`. The result also stays on `window.__aeExtract` (Chrome cuts the return at 1,000 characters): return pieces of `.result`, or `.send(port)` posts it to `receiver.mjs`. |
| `scripts/listing.js` | **Detail-page reader.** `await read()`: expands, then returns text AND images in one call. Shadow-DOM aware, block-aware; `gallery` is the product's own photos only (other products counted in `excludedImages`); reads the description (from its shadow tree, or fetched when a hidden tab left it unrendered) into `text`, `sizeLines` and `descriptionImages`; separates product size from carton size, reads options only from the option selector (`selectedVariant` too), returns the own vs pooled review counts, reports `visibility` and `warnings`, keeps the result in `last` before the description fetch, `changed()` proves a re-read is owed. |
| `scripts/labels.sh` | Downloads gallery images and makes their printed text readable (WebP→PNG, crop + upscale). The label on the case is the spec sheet. |
| `scripts/rank.mjs` | Ranker. Bayesian shrinkage (own rating in final mode), log volume, neutral brand default, `--require` filter, `--spread` tier stratification, `--constraint` hard filters, absence, off-query (`off-query-results`, `-connector`, `-keywords`) and `tie-at-cutoff` warnings, `sold-unparsed` and `own-reviews-unknown` set-asides with warnings, strict flag values. |
| `scripts/lib.mjs` | Pure helpers (`parseSold`, `SOLD_RE`, `parseReviewBlock`, `median`, `clean`, **`wallVerdict`**, `queryRelevance`) shared by ranker, browser files, the step-5 reader and tests. |
| `scripts/test.mjs` | Assertion suite incl. regression guards for every defect below. It also runs the step-5 reader, pulled out of this file. |
| `scripts/fixtures/` | Real titles for the relevance tests: `real-titles-2026-10-17.json` (craft wire served for `wired usb mouse`, a real mouse stream), `real-streams-2026-10-19.json` (POCO phones for `poco f7 ultra wallet case`, cables for `type c iem`, three correct streams), `live-streams-2026-10-19.json` (18 labelled live captures). |

`harvest.js`, `extract.js` and `listing.js` run in the browser and cannot import
`lib.mjs`, so each inlines the helpers it needs (`parseSold`, `SOLD_RE`,
`parseReviewBlock`, `wallVerdict`, `queryRelevance`) between `@shared:*`
markers, and so does the step-5 reader in this file. `test.mjs` pulls **every** copy out and asserts it
matches `lib.mjs` on every fixture — keep them in sync, the test will catch you
if you don't. A drifted `wallVerdict` means one entry point silently stops
detecting walls; a drifted `SOLD_RE` means best sellers silently lose their
sold count.

### Defects fixed 2026-10-19 (the Poco F7 Ultra wallet case session)

Two searches on the same day were served as another category, and the
relevance check passed both as `exhausted-all-results`.
`poco f7 ultra wallet case` gave 143 POCO items, no phone case (share
0.979, on the brand word `poco`). `type c iem` gave 49 items, mostly
USB-C cables and chargers, no IEM (share 0.857, on `type`). The first was
caught only because the operator read `keywordShare` by eye; the second
was not caught. Guards: `off-query-connector` and `off-query-keywords`
(step 3, "One word can carry another category"). Tests R-BRAND and
R-BRAND-2 fail on the code before the fix. The real titles are in
`scripts/fixtures/real-streams-2026-10-19.json` and
`scripts/fixtures/live-streams-2026-10-19.json`.

A review of the first version (41 agents, 32 of 36 findings confirmed)
found that it stopped counting connector words for the share. That
called the real IEM stream off-query after 1 or 2 pages. The rules were
then chosen by scoring variants on labelled streams.

A second review (49 agents, 42 of 44 findings confirmed, nearly all low)
found more, all fixed with tests (R-BRAND-3):

- titles that write `TypeC` or `USBC` as one word no longer matched;
- the UK map missed UK plurals and joins (`Organisers`, `Centrepiece`)
  and `adaptor`;
- `off-query-connector` fired when no title held the connector word;
- it fired on correct streams named in other words (`usb c lead`,
  `type c earpods`, `usb c dongle`) and on spec-only queries over
  cable pages (`usb c 2m`);
- `dupe` counted as a missing keyword;
- the warning text miscounted when the query had a connector word;
- `rank.mjs` compared merge queries letter by letter (`Poco` vs
  `poco`), and its merge test passed even without the fix;
- 25 changes to the rule passed the old tests. Most are now caught.
- `build.mjs` could hang with no timeout.

Also fixed in the first review: `rank.mjs` raising the new warnings on a
merge of two correct streams of different queries, and a query word
`constructor` held by every title.

**Do not let review agents browse the live site.** That review's
verifiers loaded AliExpress about 60 times on their own, tripped the
CAPTCHA in the signed-in Chrome and in the in-app browser, and changed the
in-app browser's language cookies. A review prompt must forbid browser
tools and network requests to the site.

### Defects fixed 2026-10-18 (the wired-USB-mouse session and its review)

Found in a live run on 2026-10-17, then a review ran the real code (41
confirmed findings, about 30 distinct). Each has a test in `test.mjs` that
fails on the code before the fix.

1. **The harvest was lost twice on export.** The receiver had exited after
   its one payload; `send()` treated the refused fetch like a held one,
   posted the form to the dead port, the tab went to `chrome-error://`, and
   the reply still read "form-posted …". Guards: a refused fetch returns
   `NOT DELIVERED` and never navigates (a plain `send()`; `{via: 'form'}`
   always posts the form, so the curl check guards it); every reply starts with
   `DELIVERED` / `NOT DELIVERED` / `UNCONFIRMED`; the state is saved to
   `localStorage` after every page and before any form POST, and
   `restore()` brings it back in any tab of the origin; no backup, no form
   (unless `force`). The receiver now takes any number of payloads and idles
   out after 60 minutes; `GET /` answers `ok …` for a check before `send()`.
2. **An off-category stream was "all results".** `wired usb mouse` was
   served as craft wire (281 of 282 items) and ranked. Guard:
   `queryRelevance()` (lib.mjs, inlined in `harvest.js`): verdict
   `off-query`, a warning in the payload and in `rank.mjs`.
3. **The recovery path re-read what it had.** `start()` always began at
   page 1 and `maxRequests: 0` became 24; `decode.mjs` kept only the first of
   several payloads. Guards: `restore()`, `startPage`, a zero budget stays
   zero, `decode.mjs` merges (verdict complete only for pages 1..N with no
   gap).
4. **Silent stops and wrong stops.** A carved page of another shape threw
   out of `step()` and its page was skipped; stops were final; a re-install
   or `start()` beside a running loop made two loops; the big-HTML wall rule
   could never fire in the harvester. Guards: a named `parse-error`,
   `resume()`, refusals, and the rule run on the page's visible text.
5. **The ranker scored the wrong things.** The pooled JSON-LD rating was
   shrunk with the own count (now `ownRating` in final mode); a researched
   house brand at the old ~0.35 ranked below unresearched items (now 0.5,
   below 0.5 needs a named problem); a finalist with no count at all was
   "thin"; `--require` was blamed when constraints emptied the pool; a typo
   in a flag value gave an empty ranking; ties at the cut, reviews against
   a sold floor, and `--min-evidence 0` were mishandled.
6. **The detail reader hid things.** The product size was called the carton
   when a sibling said "Package includes"; bold-label sizes were skipped; a
   wall or an HTTP error page passed as the description; a 20,000-character
   cut dropped the description whole; only the first selected option was
   kept; no reader returned the spec rows a hard requirement is decided on.
   Guards: each one in `listing.js` and the step-5 reader (`spec`,
   `specs`).
7. **The DOM fallback read "Bluetooth 5.0" as the rating.** The sold number
   after the rating must now be a well-formed count.
8. **The install paste was 31 KB with invisible characters.** Now
   `dist/*.min.js`, generated and tested, and every bidi mark in the source
   is a `\u` escape.

Common cause: a result was reported without checking that it happened (a
send, a stream, a page, a rating).

Two review rounds of these fixes then ran the real code and confirmed 27
more (19, then 8), all fixed with tests that fail on the reviewed code. The
ones that change how to work: backups are one key per run, the 3 saved last kept,
and `start()` saves at once; a page is counted only after all of it parsed;
the relevance rule is "any keyword" (a head-word rule and a qualifier list
both raised false alarms on correct streams; two narrow rules joined it on
2026-10-19, see step 3); `decode.mjs` joins pages only
within one stream (query, `fourStar`, `extra`) and names chunk sets by a
payload hash; `rank.mjs` repeats every warning a payload carries; a `<br>`
splits a size line; the nearest label decides carton vs product;
`listing.js` reads spec text rows by name and returns `specsText`;
`build.mjs` refuses a copy that does not parse.

A third review, at higher effort (six reviewers, the listing cases run in real
Chromium), confirmed about 50 more, all fixed with tests that fail on the
reviewed code. What changes how to work: **export with
`send(8765, {via: 'form'})`** (the in-app browser blocks every loopback fetch, and the live check the same day found signed-in Chrome refusing it too); a bare size
takes its label from the element before it (a table cell, a `<dt>`, a span);
"Packaging", "Box" and "Carton" sizes are cartons (a "Box" only when said as
packaging, never a "Lunch Box"); carousel titles are never
this product's sizes; relevance matches whole words and their inflections
only ("water" is not "waterproof") and leaves non-English titles unmeasured;
`decode.mjs` keeps every part's pages so a merged file can be merged again,
and calls a stream that changed between runs `truncated`; `rank.mjs` says
WHY a ranking is empty (unchecked is not failing), refuses unknown flags and
blank values, and flags `brand-implausible`; `test.mjs` runs the whole suite a
second time on the dist copies, compares every shared block's CODE with
`lib.mjs`, and checks the README's assertion count.

A recheck of those fixes on 2026-10-19 found nine more. Each has tests
that fail on the code before the fix. Eight are fixed, and one only in part
(see "Still open" below). What changes how to work:
relevance takes "-es" off only after s, x, z, ch, sh or o ("tubes" is
not "tub"), and a title join never rebuilds an ending ("Wire D" is not
"wired"); a `decode.mjs` merge keeps `coverage.streamVerdict` and
`relevance.offSample`; the page title decides whether a "box" size is the
product's own; the step-5 header takes a comma or a dot as its separator;
`rank.mjs` refuses one-hyphen, upper-case and em-dash flags, stray words
and a bad `--require` regex (exit 2), reads a `brandScore` string, sets
aside one outside 0..1, and names every finalist it sets aside. Still open,
by design: a synonym stream ("Earbuds" for "earphones") is flagged
`off-query`, and a join of two real words ("Car Pet" for "carpet") passes.
Read `relevance.offSample` and the titles.

### Defects fixed 2026-09-29 (the rotary-grater session)

Found during a live run in signed-in Chrome, then checked on two detail
pages. Each has a guard in code, and its tests fail on the old code.

1. **The harvest stopped at page 1 and called it exhausted.** `harvest.js`
   ended the run on `pageInfo.finished: true`. That flag was true on every
   page served: `cheese grater` pages 1-3 each carried it, and page 3 still
   held 60 new ids. The stream really ended with an empty page 5, at 230
   items. The run was saved only because the operator noticed that
   "cheese grater" could not have just 60 results. Guard: the run ends only on
   an empty page (`endSignal: 'empty-page'`) or a page with no new ids
   (`no-new-ids`); the flag is recorded per page and never trusted. A short
   page is not an end (`vegetable slicer`: 48, then 1 more, then empty).
2. **The gallery was other products.** `listing.js` returned every image of
   400 px or more. On one listing 8 of 15 were not the product: related
   items, the footer licence badge, category menu icons. On another it kept
   1 of 9 product photos, because the slider serves them at 220 px. The
   description text never reached `text`: it renders in a shadow root, and
   `text` was `body.innerText`, which excludes shadow content ("Weight:
   about 750 g" on screen, absent from `text`). Guard: images are sorted by
   page zone (`main-image--wrap` is the product), restored to full size,
   and other products are counted in `excludedImages`; the description is
   read from its shadow tree into `text`, and its images come back as
   `descriptionImages`.
3. **A hidden tab broke timers, screenshots and page text, silently.** The
   connector's window was hidden. A 2,500 ms timer inside a read never fired
   and the 45 s tool call timed out with no result; a screenshot, a zoom and
   `get_page_text` each hung the same way; the description was not rendered
   anywhere on the page. Guard: every browser script reports `visibility`;
   `listing.js` warns and
   fetches the description itself from the URL the page already requested;
   `send()` skips its timer-based fetch race when hidden; this file forbids
   page timers and names what needs the window in front.

Common cause: a signal was trusted without checking what it measured (a
flag, an image size, a DOM walk that looked complete).

An independent review of these fixes (13 findings, 8 confirmed by a second
agent, several live) found more, all fixed with tests that fail on the
reviewed code:

- **Text out of order.** Reading each element's own text in
  `querySelectorAll` order turned `<li><b>Weight:</b> about 680 g</li>` into
  "about 680 g Weight:". `textOf()` now follows tree order.
- **Seller copy read as a wall.** A description saying "please slide the
  drum in" was thrown away as `blocked`. Wall phrases in the TEXT now count
  only when the fetch returned nothing usable; the URL and the captcha HTML
  are always checked.
- **A real wall on the description fetch passed as "unknown".** It now sets
  the top-level `blocked` / `suspectedWall`, the same STOP as a page wall.
- **A stalled description fetch lost the whole read.** `read()` stores the
  rest in `__aeListing.last` first; `read({ description: false })` skips
  the fetch.
- **Overlapping `step()` calls ended a harvest early.** After a tool timeout
  the page loop runs on; a second call fetched the same page, found no new
  ids and stopped a 600-item run at 240. `step()` now refuses while
  `running`.
- **The stuck-tab advice threw the harvest away.** Export first, then open a
  fresh tab (step 0, "A hidden tab").

### Defects fixed 2026-09-25 (the fidget-toys and stress-ball sessions)

Found during a live run, then checked on 17 detail pages across two searches.
Each one has a guard in code, and its tests fail on the old code.

1. **"100K+ sold" could not be read, so the best sellers vanished.** From
   100,000 up the storefront writes a K. `SOLD_RE` allowed no letter before
   "sold" and `parseSold` knew no K, so the two best sellers of a 1,228-item
   harvest (orders-sort positions 1 and 2) got `sold: null`, and `rank.mjs`
   dropped them as `evidence<100` without a word. They were found only because
   positions 1 and 2 were missing from the fetch list. Guard: K and M in
   `parseSold` and `SOLD_RE`, every copy drift-guarded; the harvester keeps an
   unreadable sold text as `soldText`; `rank.mjs` sets such items aside as
   `sold-unparsed` and names the text in a warning. Checked live: the fixed
   harvester read both 100K+ listings of a "stress ball" harvest as 100,000.
2. **Step 5 ranked on a pooled review count.** The JSON-LD `reviewCount`
   equals the header "N Reviews", and on most listings it combines similar
   items from other sellers. The page says "Reviews displayed are from various
   sellers for similar items". The review block's "N ratings" is the listing's
   own count: 5,479 vs 1,090, 9,460 vs 1,914, 4,779 vs 488, and 37 vs 37 on the
   one listing without the note. A first ranking built on the pooled numbers
   was wrong. Guard: `parseReviewBlock` (lib.mjs, inlined in `listing.js` and
   in the step-5 reader); the reader returns `reviews` (own) and
   `pooledReviews` separately; `rank.mjs` sets a finalist that has only the
   pooled count aside as `own-reviews-unknown`. `test.mjs` runs the step-5
   reader from this file against sample pages.
3. **Options were read from reviews.** `listing.js` took any element whose
   class mentioned "sku". That returned review lines ("Color:D Ships
   From:China Mainland", often from other sellers' items) and the property
   title, and it missed every image option. It matters because JSON-LD reports
   the selected option's price: a "$2.14 keychain" was the 1-key option, not
   the 9-key pad in its title. Guard: options only from `sku-item--image` and
   `sku-item--text`, plus `selectedVariant`.

Common cause: a number was used without checking what it counted.

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
   now returns `reviews` (own) and `pooledReviews`, plus `pooledNote`, so the
   report can say which it is. (This line used to name `ownReviews`/`pooled`,
   names no code ever read.)

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
