/* AliExpress search-results extractor.
 *
 * Pass the WHOLE contents of this file as the `text` argument of
 * mcp__Claude_Browser__javascript_tool. It evaluates to a JSON string.
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
    freeShipping: o.freeShipping != null ? o.freeShipping : null,
    reviews: null, // search page never exposes this; detail page JSON-LD does
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
      out.push(mk({
        id,
        title: clean((it.title && it.title.displayTitle) || ''),
        price: typeof sale.minPrice === 'number' ? sale.minPrice : null,
        wasPrice: typeof orig.minPrice === 'number' ? orig.minPrice : null,
        discountPct: typeof sale.discount === 'number' ? sale.discount : null,
        rating: it.evaluation && typeof it.evaluation.starRating === 'number'
          ? it.evaluation.starRating : null,
        soldRaw: m ? m[1].replace(/\s/g, '') : null,
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

      // Walk up until we find the ancestor holding the full card text.
      let node = a;
      let text = '';
      for (let i = 0; i < 7 && node; i++) {
        node = node.parentElement;
        if (!node) break;
        const t = clean(node.textContent);
        if (t.length > text.length) text = t;
        if (text.length > 120) break;
      }
      if (text.length < 25) return;
      seen.add(id);

      // Rating and sold are glued together: "<rating><sold> נמכרו"
      const rs = text.match(/([1-5]\.\d)\s*([\d.,]+\s*\+?)\s*נמכר/);
      // Every shekel amount, in order: [current, original]
      const money = [...text.matchAll(/₪\s*([\d,]+(?:\.\d+)?)/g)]
        .map((m) => Number(m[1].replace(/,/g, '')))
        .filter((n) => Number.isFinite(n));
      const pct = (text.match(/(\d+)%-/) || [])[1];

      items.push(mk({
        id,
        title: clean(text.split('₪')[0]),
        price: money[0] != null ? money[0] : null,
        wasPrice: money[1] != null ? money[1] : null,
        discountPct: pct ? Number(pct) : null,
        rating: rs ? Number(rs[1]) : null,
        soldRaw: rs ? rs[2].replace(/\s/g, '') : null,
        freeShipping: /משלוח חינם/.test(text),
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
  const verdict = wallVerdict({
    url: location.href,
    text: ((document.body && document.body.innerText) || '') + ' ' + (document.title || ''),
    html: _html,
    dataNodes: items.length,
  });
  const blocked = verdict.state === 'blocked';

  return JSON.stringify({
    url: location.href,
    page: Number(new URLSearchParams(location.search).get('page') || 1),
    source,
    blocked,
    suspectedWall: verdict.state === 'suspect',
    wall: verdict,
    cardCount: items.length,
    withRating: items.filter((i) => i.rating !== null).length,
    items,
  }, null, 0);
})()
