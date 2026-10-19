/* AliExpress search-results extractor.
 *
 * Pass the WHOLE contents of this file (or of dist/extract.min.js, the same
 * code without comments) as the `text` argument of javascript_tool. It
 * evaluates to a JSON string. The Chrome connector cuts that string at 1,000
 * characters, so the result also stays on `window.__aeExtract` (`.result`,
 * and `.send(port)` to post it to receiver.mjs); see the end of this file.
 *
 * TWO SOURCES, tried in order:
 *
 *  1. `window._dida_config_._init_data_` — the payload the page was rendered
 *     from. Holds ~60 fully-structured records (productId / title / prices /
 *     evaluation.starRating / trade.tradeDesc). This is the preferred source:
 *     it does not depend on anything being painted, so it still works when the
 *     Browser pane is hidden or collapsed.
 *  2. DOM cards — the old path, kept as a fallback for layouts where the
 *     global is missing.
 *
 * WHY SOURCE 1 MATTERS (verified 2026-07-30): with the Browser pane hidden the
 * results container renders at clientHeight 0, IntersectionObserver never
 * fires, and lazy loading stalls — the DOM yielded 13 cards while the embedded
 * JSON on the same page held 60. Roughly 9 of those 13 DOM cards were also SEO
 * keyword-stuffing links with every field null.
 *
 * Other hard-won details (all verified against he.aliexpress.com):
 *  - MUST be wrapped in an IIFE. The JS context persists between calls, so a
 *    bare `const x` throws "Identifier 'x' has already been declared".
 *  - MUST use textContent, not innerText. Cards are often not painted yet and
 *    innerText returns "" for all of them while textContent returns the text.
 *  - DOM card fields are glued with no separators ("4.8208 נמכרו"), so rating
 *    and sold must be split by one anchored regex, not two independent ones.
 *  - RTL bidi control marks break naive number regexes; they are stripped.
 *  - "sold" is BUCKETED ("1,000+", "5,000+") and saturates at "10,000+".
 *  - `__INIT_DATA__` really is undefined and `runParams` really is empty —
 *    but `_dida_config_._init_data_` is not. Use it.
 */
(() => {
  const BIDI_RE = new RegExp("[\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]", "g");
  const clean = (s) => (s || '').replace(BIDI_RE, '').replace(/\s+/g, ' ').trim();

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
   *
   * From 100,000 up the storefront writes a K: "100K+ sold" (measured
   * 2026-09-25, the two best sellers of a 1,228-item harvest). This used to
   * return null, and rank.mjs then dropped both best sellers as
   * "evidence<100" without a word. K and M multiply. Before them, one
   * separator followed by 1-2 digits is a decimal mark ("1.2K", "1,2K").
   */
  function parseSold(raw) {
    if (raw == null) return null;
    const s = String(raw)
      .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
      .replace(/\s+/g, '')
      .replace(/\+/g, '');
    if (!s) return null;
    const unit = s.slice(-1).toLowerCase();
    const mult = unit === 'k' ? 1e3 : unit === 'm' ? 1e6 : 1;
    let body = mult === 1 ? s : s.slice(0, -1);
    if (mult !== 1) body = body.replace(/[.,](?=\d{1,2}$)/, '.');
    const cleaned = body.replace(/[.,](?=\d{3}(?:\D|$))/g, '');
    if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
    const n = Number(cleaned) * mult;
    if (!Number.isFinite(n)) return null;
    return mult === 1 ? n : Math.round(n);
  }
  /* @shared:parseSold:end */

  /* @shared:soldRe:start */
  /* "1,000+ נמכרו" on a Hebrew page, "10,000+ sold" on an English one — the
   * marker follows the page locale, which a signed-in account controls. From
   * 100,000 up the number carries a K ("100K+ sold", measured 2026-09-25);
   * without [KkMm] the match failed and the best sellers had no sold. */
  const SOLD_RE = /([\d.,]+\s*[KkMm]?\s*\+?)\s*(?:נמכר|sold)/i;
  /* @shared:soldRe:end */
  /* Grid prices: "₪22.30" on the Israeli storefront, "US $4.92" for a USD
   * account, "€3.10" elsewhere. One regex, currency symbol captured. */
  const MONEY_RE = /(₪|US\s?\$|\$|€|£)\s*([\d,]+(?:\.\d+)?)/g;

  const mk = (o) => ({
    id: o.id,
    url: 'https://he.aliexpress.com/item/' + o.id + '.html',
    title: (o.title || '').slice(0, 140),
    price: o.price != null ? o.price : null,
    currency: o.currency || null,
    wasPrice: o.wasPrice != null ? o.wasPrice : null,
    discountPct: o.discountPct != null ? o.discountPct : null,
    rating: o.rating != null ? o.rating : null,
    soldRaw: o.soldRaw || null,
    sold: parseSold(o.soldRaw),
    soldBucketed: o.soldRaw ? /\+/.test(o.soldRaw) : null,
    // The grid's sold text, kept only when it did not parse, so an unknown
    // format reaches rank.mjs as visible text instead of a silent null.
    soldText: o.soldText || null,
    freeShipping: o.freeShipping != null ? o.freeShipping : null,
    reviews: null, // search page never exposes this; the detail page's review block does (step 5)
  });

  // ---------- source 1: embedded render payload ----------
  function findItemArray(root) {
    // Known path first, then a bounded deep walk so a path change degrades
    // to "slower" rather than "broken".
    try {
      const known = root.data.data.root.fields.mods.itemList.content;
      if (Array.isArray(known) && known.length) return known;
    } catch (e) { /* fall through to the walk */ }

    let best = null;
    const seen = new Set();
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 10 || seen.has(o)) return;
      seen.add(o);
      if (Array.isArray(o)) {
        if (o.length && o[0] && typeof o[0] === 'object' && o[0].productId) {
          if (!best || o.length > best.length) best = o;
        }
        for (let i = 0; i < Math.min(o.length, 6); i++) walk(o[i], depth + 1);
        return;
      }
      for (const k of Object.keys(o)) walk(o[k], depth + 1);
    };
    walk(root, 0);
    return best;
  }

  function fromInitData() {
    const cfg = window._dida_config_;
    const root = cfg && cfg._init_data_;
    if (!root) return [];
    const arr = findItemArray(root);
    if (!Array.isArray(arr)) return [];

    const out = [];
    const seen = new Set();
    for (const it of arr) {
      const id = String((it && it.productId) || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const prices = it.prices || {};
      const sale = prices.salePrice || {};
      const orig = prices.originalPrice || {};
      const desc = clean((it.trade && it.trade.tradeDesc) || '');
      const m = desc.match(SOLD_RE);
      const soldRaw = m ? m[1].replace(/\s/g, '') : null;
      out.push(mk({
        id,
        title: clean((it.title && it.title.displayTitle) || ''),
        price: typeof sale.minPrice === 'number' ? sale.minPrice : null,
        currency: typeof sale.currencyCode === 'string' ? sale.currencyCode : null,
        wasPrice: typeof orig.minPrice === 'number' ? orig.minPrice : null,
        discountPct: typeof sale.discount === 'number' ? sale.discount : null,
        rating: it.evaluation && typeof it.evaluation.starRating === 'number'
          ? it.evaluation.starRating : null,
        soldRaw,
        soldText: desc && parseSold(soldRaw) === null ? desc.slice(0, 80) : null,
      }));
    }
    return out;
  }

  // ---------- source 2: rendered DOM cards ----------
  function fromDom() {
    const seen = new Set();
    const items = [];
    document.querySelectorAll('a[href*="/item/"]').forEach((a) => {
      const id = (a.href.match(/\/item\/(\d+)/) || [])[1];
      if (!id || seen.has(id)) return;

      /* Walk up until we find the ancestor holding the full card text, but
       * never into an ancestor that also holds ANOTHER item's link: that is
       * the grid. A short card (no rating, no sold) climbed up to it and
       * took the first card's title, price, rating and sold (review,
       * 2026-10-18). */
      const otherItem = (n) => {
        try {
          for (const l of n.querySelectorAll('a[href*="/item/"]')) {
            const o = (String(l.href || '').match(/\/item\/(\d+)/) || [])[1];
            if (o && o !== id) return true;
          }
        } catch (e) { /* no querySelectorAll */ }
        return false;
      };
      let node = a;
      let text = '';
      for (let i = 0; i < 7 && node; i++) {
        node = node.parentElement;
        if (!node || otherItem(node)) break;
        const t = clean(node.textContent);
        if (t.length > text.length) text = t;
        if (text.length > 120) break;
      }
      if (text.length < 25) return;
      seen.add(id);

      /* Rating and sold are glued together: "<rating><sold> נמכרו" / "... sold".
       * The sold number must be a WELL-FORMED count right after the rating:
       * digits with 3-digit groups ("1,000", "4.000"), or digits with at most
       * one decimal before a K/M ("1.2K"). A loose [\d.,]+ let a version
       * number in the title win: "Bluetooth 5.0 4.81,000+ sold" read as
       * rating 5.0 and sold "4.81,000+" -> 4.81 (measured 2026-10-18). */
      const rs = text.match(/([1-5]\.\d)\s*((?:\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d)?(?=\s*[KkMm])|\d+)\s*[KkMm]?\s*\+?)\s*(?:נמכר|sold)/i);
      // Every price, in order: [current, original]; the symbol says the currency
      const moneyM = [...text.matchAll(MONEY_RE)];
      const money = moneyM
        .map((m) => Number(m[2].replace(/,/g, '')))
        .filter((n) => Number.isFinite(n));
      const sym = moneyM.length ? moneyM[0][1] : '';
      const currency = /₪/.test(sym) ? 'ILS' : /\$/.test(sym) ? 'USD'
        : sym === '€' ? 'EUR' : sym === '£' ? 'GBP' : null;
      const pct = (text.match(/(\d+)%-|-(\d+)%/) || []).slice(1).find(Boolean);

      items.push(mk({
        id,
        title: clean(sym ? text.split(sym)[0] : text),
        price: money[0] != null ? money[0] : null,
        currency,
        wasPrice: money[1] != null ? money[1] : null,
        discountPct: pct ? Number(pct) : null,
        rating: rs ? Number(rs[1]) : null,
        soldRaw: rs ? rs[2].replace(/\s/g, '') : null,
        freeShipping: /משלוח חינם|free shipping/i.test(text),
      }));
    });
    return items;
  }

  let items = [];
  let source = 'init-data';
  try { items = fromInitData(); } catch (e) { items = []; }
  if (!items.length) {
    source = 'dom';
    try { items = fromDom(); } catch (e) { items = []; }
  }

  // A captcha/punish interstitial yields no items from either source. Say so
  // explicitly instead of returning a plausible-looking empty result. A QUIET
  // wall yields the same zero items, so `items.length` is the signal that
  // decides — see wallVerdict above.
  let _html = '';
  try { _html = (document.documentElement && document.documentElement.outerHTML) || ''; } catch (e) {}
  /* A page that returned items served content. Its text counts only for the
   * wall's own sentences, as in listing.js, and never through the items'
   * titles: one title "Sliding door lock, please slide to lock" made a page
   * of 3 items a CONFIRMED wall, and the note said STOP (recheck,
   * 2026-10-18). The URL and the captcha HTML always count. */
  const STRONG_WALL = /unusual traffic|slide to verify|(להחליק|החלק|גרור|המחוון)[^.]{0,40}(לאמת|אימות)/i;
  let _text = ((document.body && document.body.innerText) || '') + ' ' + (document.title || '');
  if (items.length) {
    for (const it of items) if (it.title && it.title.length >= 8) _text = _text.split(it.title).join(' ');
    if (!STRONG_WALL.test(_text)) _text = '';
  }
  const verdict = wallVerdict({
    url: location.href,
    text: _text,
    html: _html,
    dataNodes: items.length,
  });
  const blocked = verdict.state === 'blocked';

  const out = {
    // Path only: the Chrome connector blocks a result that carries a query
    // string, and a search URL always has one.
    url: location.origin + location.pathname,
    page: Number(new URLSearchParams(location.search).get('page') || 1),
    source,
    blocked,
    suspectedWall: verdict.state === 'suspect',
    wall: verdict,
    // 'hidden' explains a thin DOM fallback (the grid lazy-loads only while
    // visible) and warns that screenshots and get_page_text will hang.
    visibility: (() => { try { return typeof document.visibilityState === 'string' ? document.visibilityState : 'unknown'; } catch (e) { return 'unknown'; } })(),
    cardCount: items.length,
    withRating: items.filter((i) => i.rating !== null).length,
    items,
  };
  const json = JSON.stringify(out, null, 0);
  /* The Chrome connector cuts a tool result at 1,000 characters, and this
   * one is about 20,000 for 60 items, so the fallback could not be read
   * there (recheck 2026-10-18, F23). The result also stays on the window:
   * return pieces of __aeExtract.result, or post it all to receiver.mjs
   * with __aeExtract.send(port) after the curl check. send() is the same
   * top-level text/plain form POST as harvest.js send(port, {via: 'form'}),
   * so it navigates, to a dead port too. Nothing is lost then: the items are
   * on the search page, so navigate back and run this file again. The
   * in-app browser reads the whole return value, as before. */
  try {
    window.__aeExtract = {
      result: out,
      send(port) {
        const url = 'http://127.0.0.1:' + (port || 8765) + '/harvest';
        const f = document.createElement('form');
        f.method = 'POST'; f.action = url; f.enctype = 'text/plain';
        const ta = document.createElement('textarea');
        ta.name = 'payload'; ta.value = json;
        f.appendChild(ta);
        document.body.appendChild(f);
        f.submit();
        return 'UNCONFIRMED: form-posted ' + json.length + ' chars (' + items.length + ' items) to ' + url +
               ' - delivered only if the receiver prints "saved <path>" in its own output. If it printed nothing, ' +
               'navigate back to the search page and run extract.js again';
      },
    };
  } catch (e) {}
  return json;
})()
