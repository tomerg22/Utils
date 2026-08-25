/* AliExpress PAGED search harvester — resumable, block-aware.
 *
 * Pass the WHOLE contents of this file as the `text` argument of
 * mcp__Claude_Browser__javascript_tool. It installs `window.__aeHarvest`
 * and returns a short status string. Then drive it:
 *
 *   __aeHarvest.start({ query: 'wire brush set' })   // returns the plan
 *   __aeHarvest.step(8)                              // repeat until done
 *   __aeHarvest.payload()                            // JSON for rank.mjs
 *
 * WHY THIS EXISTS (measured 2026-08-21)
 * extract.js reads ONE page of ~60 records. That made recall a function of
 * how well the operator guessed the listing's wording. A real miss: a 7-inch
 * hand wire brush, 4.9 from 123 reviews, was absent from every query tried —
 * yet it sits at PAGE 6, INDEX 2 of a plain `wire brush set` search.
 *
 * SKILL.md used to claim "&page=2 is not more of the same". That is FALSE and
 * has been removed. Measured on he.aliexpress.com:
 *   - wire brush set : pages 1-12 -> 709 unique, 59-60 fresh on EVERY page,
 *                      zero duplicates, zero category drift.
 *   - travel duffel  : pages 1-8  -> 473 unique, 100% fresh per page,
 *                      98% on-category, 59-60/60 rows rated per page.
 * Drift IS real but only DEEP and only UNFILTERED: page 40 of an unfiltered
 * brush search returns hair clips, and page 60 is the hard ceiling.
 *
 * THREE THINGS THIS FILE GETS RIGHT THAT AD-HOC PAGING DID NOT
 *
 * 1. A WALL MUST NEVER LOOK LIKE A PARSE BUG.
 *    The anti-bot page (/_____tmd_____/punish, rotating x5secdata, a
 *    `nc_1_nocaptcha` slider) has no payload, so a naive parser just returns
 *    null and the caller logs "parse failed" and moves on. That happened.
 *    blockedBy() is checked BEFORE parsing and sets stop='blocked', which the
 *    caller MUST surface to the user immediately — see SKILL.md step 2.
 *
 * 2. RESUMABILITY. javascript_tool dies at 30s, which is ~8-12 fetches. State
 *    lives on window so step() can be called repeatedly across tool calls.
 *
 * 3. NO setTimeout PACING. A hidden Browser pane throttles timers, which
 *    silently defeated an AbortController during testing. Pacing comes from
 *    awaiting fetches sequentially — that is already ~1s apart.
 *
 * REQUESTS ARE THE SCARCE RESOURCE, NOT RESULTS. The wall tripped after
 * roughly 50-60 rapid fetches in one session. Hence maxRequests, and hence
 * the 4-star filter (see start()), which roughly triples usable rows per
 * request instead of spending more requests.
 */
(() => {
  const BIDI_RE = new RegExp("[\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]", "g");
  const clean = (s) => (s || '').replace(BIDI_RE, '').replace(/\s+/g, ' ').trim();

  /* @shared:parseSold:start */
  /* Parse an AliExpress "sold" string into a number.
   *
   * The Hebrew storefront uses BOTH "," and "." as the thousands separator —
   * real observed values include "10,000+" AND "4.000+". Stripping only ","
   * turns "4.000+" into 4, which silently drops a 4,000-sold item below any
   * evidence floor. Both separators must be handled.
   *
   * A separator is only treated as a thousands mark when exactly 3 digits
   * follow it, so a genuine decimal ("1.5") is left alone rather than
   * misread as 15.
   */
  function parseSold(raw) {
    if (raw == null) return null;
    const s = String(raw)
      .replace(/[‎‏‪-‮⁦-⁩]/g, '')
      .replace(/\s+/g, '')
      .replace(/\+/g, '');
    if (!s) return null;
    const cleaned = s.replace(/[.,](?=\d{3}(?:\D|$))/g, '');
    if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  /* @shared:parseSold:end */

  const SOLD_RE = /([\d.,]+\s*\+?)\s*נמכר/;

  /* Same record shape as extract.js, so rank.mjs consumes either. */
  const mk = (o) => ({
    id: o.id,
    url: 'https://he.aliexpress.com/item/' + o.id + '.html',
    title: (o.title || '').slice(0, 140),
    price: o.price != null ? o.price : null,
    wasPrice: o.wasPrice != null ? o.wasPrice : null,
    discountPct: o.discountPct != null ? o.discountPct : null,
    rating: o.rating != null ? o.rating : null,
    soldRaw: o.soldRaw || null,
    sold: parseSold(o.soldRaw),
    soldBucketed: o.soldRaw ? /\+/.test(o.soldRaw) : null,
    /* The grid thumbnail. Captured because physical attributes (wires,
     * connector type, enclosure) are NEVER in the title — screening these
     * costs nothing against the request budget, since the CDN is a different
     * host from the search endpoint. Reporting "no wired module exists" from
     * a title search was a real defect; this is the cheap way to check. */
    image: o.image || null,
    freeShipping: null,
    reviews: null, // search page never exposes this; detail page JSON-LD does
    page: o.page != null ? o.page : null,
  });

/* @shared:wallVerdict:start */
/* Decide how far to trust a page read: 'clear', 'blocked', or 'suspect'.
 *
 * WHY 'suspect' EXISTS (measured 2026-08-25, the jump-starter session)
 * The old check was a boolean over two LOUD markers: a punish URL, or
 * `nc_1_nocaptcha` / `Captcha Interception` in the text. A real wall arrived
 * in a quieter form and walked straight through it. Detail pages returned
 * 279,005 bytes of HTML with 957 bytes of rendered body text and ZERO
 * JSON-LD nodes. No marker matched that shape. The operator read the empty
 * body, reported "Not a wall — a rendering fault", and then built a whole
 * product comparison on top of that false negative, including telling the
 * user a review count was "not obtainable" when the page in fact held 1,633.
 *
 * Three rules come out of it, and all three are encoded below.
 *
 * 1. CONTENT IS THE ONLY PROOF OF NO-WALL. A wall's defining property is
 *    that it withholds content. So if data actually came back, say clear and
 *    stop worrying. If NOTHING came back, you do not get to assume why.
 *    This ordering is what keeps the check quiet: it cannot fire on a page
 *    that served you.
 *
 * 2. A QUIET MARKER IS NEVER DISMISSIBLE. In that session `punish` appeared
 *    in the HTML, the operator invented a reason it did not count ("standard
 *    anti-bot SDK, ships on normal pages") and never ran one command to
 *    check that. Constructing the explanation IS the failure mode. Here it
 *    returns 'suspect' and there is no argument that clears it except a
 *    check.
 *
 * 3. TEXT CANNOT SETTLE THIS — ONLY LOOKING CAN. A stalled render and an
 *    interstitial are identical from the text channel. Scraping harder will
 *    never separate them. That is why `note` mandates a screenshot: one call
 *    ends the ambiguity. This is the skill's own "one channel drew a blank
 *    and the blank was treated as a finding" defect, applied at last to
 *    block detection instead of only to product specs.
 *
 * signals:
 *   url        final URL after redirects
 *   text       rendered body text (document.body.innerText), or fetched body
 *   html       document.documentElement.outerHTML, or the fetched HTML, or ''
 *   dataNodes  count of usable data carriers found (JSON-LD scripts, an
 *              init-data anchor, parsed items). 0 means "nothing usable".
 *
 * NOT-A-WALL is still returned for a page that plainly is not an interstitial
 * — a short malformed response with no wall markers is a parse error, and
 * naming it that is more useful than crying wolf. 'suspect' fires only on
 * POSITIVE evidence, so it stays rare enough to be worth acting on.
 */
function wallVerdict(sig) {
  var url = (sig && sig.url) || '';
  var text = (sig && sig.text) || '';
  var html = (sig && sig.html) || '';
  var dataNodes = (sig && sig.dataNodes) || 0;
  var loud = [];

  if (/_____tmd_____|x5secdata/.test(url)) loud.push('punish-url');
  if (/nc_1_nocaptcha|Captcha Interception/i.test(text) ||
      /nc_1_nocaptcha|Captcha Interception/i.test(html)) loud.push('nocaptcha');
  if (/slide to verify|unusual traffic|please slide|יש להחליק|נא להחליק/i.test(text)) {
    loud.push('slider-text');
  }
  if (loud.length) {
    return {
      state: 'blocked', markers: loud,
      note: 'CONFIRMED anti-bot wall. STOP and tell the user THIS TURN, as the ' +
            'headline (SKILL.md step 2). Ask them to clear it. Do NOT navigate ' +
            'again while waiting — a fresh request re-arms the token.',
    };
  }

  /* Rule 1: content came back, so nothing withheld it. */
  if (dataNodes > 0) return { state: 'clear', markers: [], note: '' };

  /* No data. Every remaining branch is "I got nothing and must not guess why". */
  var quiet = [];
  if (/_____tmd_____|punish|x5secdata/.test(html)) quiet.push('punish-string-in-html');
  if (html.length > 50000 && text.length < 2000) quiet.push('big-html-no-content');
  if (!quiet.length) return { state: 'clear', markers: [], note: '' };

  return {
    state: 'suspect', markers: quiet,
    note: 'SUSPECTED wall — no usable data came back. Settle it with a SCREENSHOT ' +
          'before concluding anything: computer{action:"screenshot"} is ONE call and ' +
          'ends the ambiguity. Text alone CANNOT tell a wall from a stalled render. ' +
          'Until you have LOOKED, do NOT report "not blocked", and do NOT report the ' +
          'data as unavailable or the product as non-existent.',
  };
}
/* @shared:wallVerdict:end */

  /* The SSR payload sits behind an `init-data-start` comment marker and is a
   * JS object literal whose TOP-LEVEL key is unquoted (`= { data: {...} }`),
   * so JSON.parse on the outer object fails. The object after `data:` IS
   * strict JSON, so brace-match that and parse it. The short substring is
   * used as the anchor rather than the full comment because the full form
   * does not survive being passed through tooling intact.
   */
  function carve(html) {
    const m = html.indexOf('init-data-start');
    if (m === -1) return { err: 'no-anchor' };
    const dk = html.indexOf('data:', m);
    if (dk === -1) return { err: 'no-data-key' };
    const start = html.indexOf('{', dk);
    if (start === -1) return { err: 'no-object' };
    let depth = 0, end = -1;
    for (let i = start; i < html.length; i++) {
      const c = html[i];
      if (c === '"') { // skip strings so braces inside them do not count
        i++;
        while (i < html.length && html[i] !== '"') { if (html[i] === '\\') i++; i++; }
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) return { err: 'unbalanced' };
    try { return { obj: JSON.parse(html.slice(start, end + 1)) }; }
    catch (e) { return { err: 'json:' + String(e).slice(0, 80) }; }
  }

  function slugify(q) {
    return String(q || '').trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  const H = {
    st: null,

    /* opts:
     *   query       (required) English keywords, e.g. 'wire brush set'
     *   fourStar    default TRUE — adds filterCode:4StarRating. Measured:
     *               pool 18,655 -> 7,206, and rated rows go from 13/60 at an
     *               unfiltered page 20 to 60/60. rank.mjs already discards
     *               unrated and <4.0 items, so this removes nothing it would
     *               have kept — it just stops wasting requests on rows that
     *               get dropped anyway.
     *   maxPages    default 20   (AliExpress hard ceiling is page 60)
     *   maxRequests default 24   (the wall tripped near 50-60 in a session)
     *   extra       raw extra query string, e.g. '&shpf_co=CN' or
     *               '&attr=11795-4362329' (attribute ids come from the
     *               searchRefineFilters module — see SKILL.md step 1)
     */
    start(opts) {
      opts = opts || {};
      const slug = slugify(opts.query);
      if (!slug) throw new Error('harvest: opts.query is required (English keywords)');
      let base = 'https://he.aliexpress.com/w/wholesale-' + slug +
                 '.html?SortType=total_tranpro_desc';
      if (opts.fourStar !== false) base += '&selectedSwitches=filterCode%3A4StarRating';
      if (opts.extra) base += opts.extra;
      this.st = {
        query: opts.query, slug, base,
        fourStar: opts.fourStar !== false,
        maxPages: opts.maxPages || 20,
        maxRequests: opts.maxRequests || 24,
        page: 0, requests: 0,
        seen: new Set(), items: [], pages: [],
        claimedTotal: null, stop: null, lastErr: null, wall: null,
      };
      return { query: this.st.query, url: base + '&page=1',
               maxPages: this.st.maxPages, maxRequests: this.st.maxRequests };
    },

    /* Fetch up to n more pages. Safe to call repeatedly; returns progress.
     * Stops early on: exhausted stream, page cap, request budget, or a BLOCK.
     */
    async step(n) {
      const s = this.st;
      if (!s) return { err: 'call start() first' };
      for (let k = 0; k < (n || 1) && !s.stop; k++) {
        if (s.page >= s.maxPages) { s.stop = 'page-cap'; break; }
        if (s.requests >= s.maxRequests) { s.stop = 'request-budget'; break; }
        const p = s.page + 1;
        let html = '', finalUrl = '';
        s.requests++;
        try {
          const r = await fetch(s.base + '&page=' + p, { credentials: 'include' });
          finalUrl = r.url;
          html = await r.text();
        } catch (e) {
          s.lastErr = 'fetch:' + String(e).slice(0, 100);
          s.stop = 'fetch-error';
          break;
        }
        // Checked BEFORE the parse is trusted. A LOUD wall must never be
        // reported as a parse bug, and a QUIET one must never be reported as
        // "the page had no data" — see wallVerdict above.
        const c = carve(html);
        const verdict = wallVerdict({
          url: finalUrl, text: html, html: html, dataNodes: c.err ? 0 : 1,
        });
        if (verdict.state !== 'clear') {
          s.stop = verdict.state === 'blocked' ? 'blocked' : 'suspect-wall';
          s.wall = verdict;
          break;
        }
        if (c.err) { s.lastErr = c.err; s.stop = 'parse-error'; break; }
        s.page = p;
        const f = c.obj.data.root.fields;
        const info = f.pageInfo || {};
        if (s.claimedTotal === null && info.totalResults != null) {
          s.claimedTotal = info.totalResults;
        }
        const arr = (f.mods && f.mods.itemList && f.mods.itemList.content) || [];
        if (!arr.length) { s.pages.push({ page: p, n: 0, fresh: 0 }); s.stop = 'exhausted'; break; }
        let fresh = 0;
        for (const it of arr) {
          const id = String((it && it.productId) || '');
          if (!id || s.seen.has(id)) continue;
          s.seen.add(id);
          fresh++;
          const prices = it.prices || {};
          const sale = prices.salePrice || {};
          const orig = prices.originalPrice || {};
          const desc = clean((it.trade && it.trade.tradeDesc) || '');
          const m = desc.match(SOLD_RE);
          s.items.push(mk({
            id,
            title: clean((it.title && it.title.displayTitle) || ''),
            price: typeof sale.minPrice === 'number' ? sale.minPrice : null,
            wasPrice: typeof orig.minPrice === 'number' ? orig.minPrice : null,
            discountPct: typeof sale.discount === 'number' ? sale.discount : null,
            rating: it.evaluation && typeof it.evaluation.starRating === 'number'
              ? it.evaluation.starRating : null,
            soldRaw: m ? m[1].replace(/\s/g, '') : null,
            image: (() => {
              const im = it.image || {};
              const u = im.imgUrl || im.imgUrlOrigin || '';
              return u ? (u.startsWith('//') ? 'https:' + u : u) : null;
            })(),
            page: p,
          }));
        }
        s.pages.push({ page: p, n: arr.length, fresh });
        // `finished` is the server saying the stream is dry. Trust it over
        // claimedTotal, which is an estimate and routinely fiction: a balance
        // board query claimed 160,188 results and served nothing past page 4.
        if (info.finished === true) { s.stop = 'exhausted'; break; }
      }
      return this.status();
    },

    status() {
      const s = this.st;
      if (!s) return { err: 'not started' };
      return {
        query: s.query, pagesRead: s.page, requests: s.requests,
        unique: s.seen.size, stop: s.stop, lastErr: s.lastErr,
        blocked: s.stop === 'blocked',
        suspectedWall: s.stop === 'suspect-wall',
        wall: s.wall || null,
        claimedTotal: s.claimedTotal,
        done: s.stop !== null,
      };
    },

    /* JSON string ready to pipe into rank.mjs. `coverage` is deliberately
     * NOT a percentage of claimedTotal — that number is unreliable. What is
     * true and useful is whether the stream was exhausted or cut short.
     */
    payload() {
      const s = this.st;
      if (!s) return JSON.stringify({ err: 'not started' });
      return JSON.stringify({
        query: s.query,
        url: s.base,
        source: 'harvest-paged',
        blocked: s.stop === 'blocked',
        suspectedWall: s.stop === 'suspect-wall',
        wall: s.wall || null,
        fourStar: s.fourStar,
        coverage: {
          verdict: s.stop === 'exhausted' ? 'exhausted-all-results' : 'truncated',
          stop: s.stop,
          pagesRead: s.page,
          requests: s.requests,
          claimedTotal: s.claimedTotal,
          claimedTotalIsUnreliable: true,
        },
        pages: s.pages,
        cardCount: s.items.length,
        withRating: s.items.filter((i) => i.rating !== null).length,
        items: s.items,
      }, null, 0);
    },
  };

  window.__aeHarvest = H;
  return 'aeHarvest ready — __aeHarvest.start({query:"..."}) then __aeHarvest.step(8) until done';
})()
