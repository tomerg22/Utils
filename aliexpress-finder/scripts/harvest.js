/* AliExpress PAGED search harvester — resumable, block-aware.
 *
 * Pass the WHOLE contents of this file (or of dist/harvest.min.js, the same
 * code without comments, built by scripts/build.mjs) as the `text` argument
 * of javascript_tool. It installs `window.__aeHarvest` and returns a short
 * status string. Then drive it:
 *
 *   __aeHarvest.start({ query: 'wire brush set' })   // returns the plan
 *   await __aeHarvest.step(6)                        // repeat until done
 *   await __aeHarvest.send(8765, {via: 'form'})      // payload -> receiver.mjs, after
 *                                                    // curl -s http://127.0.0.1:8765/ answers ok
 *   (a plain send(8765) fetch was refused by both browsers on 2026-10-18)
 *   __aeHarvest.restore()                            // reload a saved harvest
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
 *    wallVerdict() is checked BEFORE parsing and sets stop='blocked' (or
 *    'suspect-wall' for a quiet one), which the caller MUST surface to the
 *    user immediately — see SKILL.md step 2.
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
 *
 * TWO BROWSERS, ONE FILE (measured 2026-09-14). This runs unchanged in the
 * in-app browser (mcp__Claude_Browser__javascript_tool) and in the Chrome
 * connector (mcp__claude-in-chrome__javascript_tool). The connector differs
 * in four ways, and every one of them is handled here rather than in prose:
 *   1. It cuts a result at 1,000 characters -> payload() is never returned
 *      through it; send() POSTs it to scripts/receiver.mjs on loopback
 *      (both browsers), and expose() + get_page_text is the fallback.
 *   2. It blocks any result holding a cookie or a query string -> start(),
 *      status() and payload() carry no URL with a "?"; debugUrl() is the
 *      in-app-only escape hatch.
 *   3. An async IIFE comes back as "{}" -> drive step() with a TOP-LEVEL
 *      await: `await __aeHarvest.step(6)`, not `(async () => ...)()`.
 *   4. A 25 s call passed and a 45 s call hit the CDP timeout -> step(6)
 *      stays the unit of work (about 8-12 s).
 * A signed-in account renders its own locale (English/USD for a USD
 * account), so the sold marker is matched in both languages and the
 * currency is recorded per item.
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
  /* The sold marker follows the page language: "1,000+ נמכרו" on a Hebrew
   * page, "10,000+ sold" on an English one (measured 2026-09-14, same item,
   * same host, only the locale cookie differed). Accept both — a signed-in
   * browser renders whatever locale the account uses, and that must not be
   * changed by us (see SKILL.md, Chrome connector rules). From 100,000 up
   * the number carries a K ("100K+ sold", measured 2026-09-25); without
   * [KkMm] the match failed and the best sellers came back with no sold. */
  const SOLD_RE = /([\d.,]+\s*[KkMm]?\s*\+?)\s*(?:נמכר|sold)/i;
  /* @shared:soldRe:end */

  /* Same record shape as extract.js, so rank.mjs consumes either. */
  const mk = (o) => ({
    id: o.id,
    url: 'https://he.aliexpress.com/item/' + o.id + '.html',
    title: (o.title || '').slice(0, 140),
    price: o.price != null ? o.price : null,
    // The account's currency (USD when signed in with a USD account, ILS on
    // the logged-out Israeli storefront). Prices are only comparable within
    // one currency, so it is carried on every record.
    currency: o.currency || null,
    wasPrice: o.wasPrice != null ? o.wasPrice : null,
    discountPct: o.discountPct != null ? o.discountPct : null,
    rating: o.rating != null ? o.rating : null,
    soldRaw: o.soldRaw || null,
    sold: parseSold(o.soldRaw),
    soldBucketed: o.soldRaw ? /\+/.test(o.soldRaw) : null,
    /* The grid's sold text, kept ONLY when it did not parse. A format the
     * parser does not know must reach rank.mjs as visible text, never as a
     * silent null: "100K+ sold" once turned the two best sellers into
     * "evidence<100" drops, with nothing to show why. */
    soldText: o.soldText || null,
    /* The grid thumbnail. Captured because physical attributes (wires,
     * connector type, enclosure) are NEVER in the title — screening these
     * costs nothing against the request budget, since the CDN is a different
     * host from the search endpoint. Reporting "no wired module exists" from
     * a title search was a real defect; this is the cheap way to check. */
    image: o.image || null,
    freeShipping: null,
    reviews: null, // search page never exposes this; the detail page's review block does (step 5)
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

/* @shared:queryRelevance:start */
/* Do the result titles belong to the query at all?
 *
 * WHY (measured 2026-10-17, the wired-USB-mouse session): the slug
 * `wholesale-wired-usb-mouse` was served as craft wire. 281 of 282 items
 * were copper or aluminium wire, the stream ran dry, and the harvest said
 * `exhausted-all-results` with no warning. rank.mjs then ranked
 * "Aluminum Craft Wire 20 Gauge" first. Nothing compared a title with the
 * query, so a whole off-category stream looked like a complete harvest.
 *
 * THE RULE: a title is on-query when it holds AT LEAST ONE query keyword as
 * a whole word or a simple inflection of it (see `bases`: plurals,
 * -er/-ing/-ed, mice/mouse; "wire" is not "wired"), or as two words written
 * apart ("Screw Driver" holds "screwdriver"). The craft wire holds none of
 * "wired", "usb", "mouse", so the live case is caught.
 *
 * WHY SO LOOSE (review of the fix, 2026-10-18): a stricter "head word"
 * rule needs to know which keyword is the noun. Taking the last word failed
 * on "mouse wired" and "mouse for computer"; a list of qualifier words
 * failed on "rc car", "coil spring" and "faux leather", whose last word is
 * the noun but was on the list. A false alarm makes the operator throw a
 * good harvest away, so the rule must not fire on a correct stream that
 * uses the query's words. The cost: an off stream that shares one keyword
 * passes (craft wire for "wire brush set"), and so does one whose title
 * words join into a keyword ("Car Pet Seat Cover" for "carpet").
 * `keywordShare` gives the share per keyword, so a low share on the noun
 * can still be seen by eye.
 *
 * WHAT IT CANNOT SEE: a synonym. "Earbuds" for "earphones" or "Cam" for
 * "camera" count as off, so on such a correct stream the check DOES fire
 * (review, 2026-10-18). Words alone cannot tell it from craft wire for
 * "wired usb mouse". So the warning quotes the titles that hold no keyword
 * (`offSample`), the payload keeps the stream's own verdict
 * (`coverage.streamVerdict`, also in a decode.mjs merge), and the operator
 * reads the titles before re-wording the query.
 *
 * A title holding a Hebrew, Arabic or Cyrillic word cannot be compared with
 * English keywords: on the Hebrew storefront "כבל USB Type C Samsung" is a
 * cable whose noun is Hebrew. Such titles are not counted; when they are
 * half or more, the stream is unmeasured, never off-query.
 *
 * ONE WORD CAN CARRY A WHOLE OTHER CATEGORY (live 2026-10-19, two streams
 * in one day, both reported as exhausted-all-results with no warning):
 *   - "poco f7 ultra wallet case" was served as 143 items: about 109 POCO
 *     phones, 31 tablets, 1 tablet case and 2 shipping-fee links, no phone
 *     case. 139 of the 143 titles held the brand word "poco", and the share
 *     was 0.979, while f7 (0.021), wallet (0) and case (0.007) were all but
 *     absent.
 *   - "type c iem" was served as 49 items: mostly USB-C cables and
 *     chargers, also flash drives, nail tips and car lights, no IEM. The
 *     word "type" was in 86% of the titles; iem was in none.
 * Two narrow rules catch this. Both were chosen by scoring variants on
 * labelled streams (real harvests and their page cuts, live captures,
 * synthetic sets), and two reviews then ran the code (2026-10-19, -20).
 *   1. `off-query-connector`: the query holds a CONNECTOR word (`type`,
 *      `usb`, `lightning`, `thunderbolt`, `hdmi`, `magsafe`; `typec` and
 *      `usbc` are split into two words first), a connector word is in half
 *      the titles or more, and EVERY other keyword is in fewer than 15% of
 *      the titles. A plug is on cables, chargers, hubs and flash drives
 *      alike, so it cannot show that the product is there. For this rule a
 *      keyword also counts when a title names the same goods in other words
 *      (GOODS below: "Cord" for "cable", "Earbuds" for "earpods").
 *      Connector words still count for the share. A first version that
 *      stopped counting them called the real IEM stream off-query when a
 *      harvest stopped after page 1 or 2: its titles say "Earphones" and
 *      "In Ear Monitor", synonyms of "iem", and "Type-C". 15%, not 5%: the
 *      live "type c 120w" stream (cables, flash drives) held "120w" in 10%
 *      of its titles, and "iem" is in 45% to 50% of the real IEM stream.
 *   2. `off-query-keywords`: the share passed, yet 3 OR MORE of the
 *      counted keywords, and more than half of them, are each in fewer
 *      than 5% of the titles. Connector words are not counted when the
 *      query has other words. A brand or model word cannot be listed
 *      (there are too many), so the rule counts what is missing instead.
 *      A correct stream usually lacks one or two query words: "mouse
 *      corded" over 326 real mice lacks "corded", and a two-word brand or
 *      two UK spellings lack 2. "dupe" is a stop word: sellers never write
 *      it. "type c iem" and "mouse corded" have the same shares (one word
 *      near 1, one near 0); only rule 1 tells them apart.
 * A UK form also gives its US form ("aluminium", "Organisers"), and
 * "magnetic" gives "magnet".
 * `missingKeywords` lists the counted keywords under 5% of the titles,
 * `connectorKeywords` the connector words of the query. On both warnings
 * `offSample` holds up to 3 titles to read before acting: on rule 1,
 * titles that hold no other keyword; on rule 2, titles that lack every
 * missing keyword.
 * WHAT IT STILL CANNOT SEE (each measured in a review): a stream that
 * lacks only 1 or 2 query words ("iphone 15 case" served as iPhones; the
 * real POCO phones for "poco wallet case" or "poco f7 case"); a device
 * query served as its accessories ("canon eos r50" over camera straps and
 * filters); a connector word the titles do not hold ("lightning earphones"
 * over USB-C earphones). Its costs on correct streams: a spec written
 * apart from the titles ("usb c 3 meter" over "3M" titles, "angled" for
 * "90 Degree"), and attribute words sellers do not use ("whisper quiet
 * cordless mouse" over silent wireless mice). Read `keywordShare`.
 */
function queryRelevance(query, titles) {
  var STOP = /^(and|for|the|with|set|sets|pcs|pc|new|of|in|on|to|a|an|kit|lot|dupe|dupes)$/;
  var CONNECTOR = /^(type|usb|lightning|thunderbolt|hdmi|magsafe)$/;
  var MISSING = 0.05;
  var CONNECTOR_ALONE = 0.15;
  var has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  var UK = { aluminium: 'aluminum', jewellery: 'jewelry', colour: 'color', colours: 'colors', grey: 'gray',
    tyre: 'tire', tyres: 'tires', metre: 'meter', metres: 'meters', centre: 'center', favourite: 'favorite',
    organiser: 'organizer', mould: 'mold', storey: 'story', cheque: 'check', adaptor: 'adapter', fibre: 'fiber',
    litre: 'liter', polarised: 'polarized', armour: 'armor', stabiliser: 'stabilizer', personalised: 'personalized',
    pyjamas: 'pajamas', sabre: 'saber', moustache: 'mustache' };
  var us = function (w) { return has(UK, w) ? UK[w] : w; };
  var words = function (s) { return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); };
  // "usbc" and "typec" in a query are "usb c" and "type c": titles write
  // "USB-C", whose "c" is one letter and never joins (F7, review 2026-10-19).
  var qwords = [].concat.apply([], words(query).map(function (w) {
    var m = w.match(/^(usb|type)c$/);
    return m ? [m[1], 'c'] : [w];
  }));
  // Each keyword once: "usb c to usb c cable" counted usb twice.
  var toks = qwords.filter(function (t, i, a) { return t.length >= 2 && !STOP.test(t) && a.indexOf(t) === i; });
  var list = (titles || []).map(function (t) { return String(t || ''); }).filter(Boolean);
  if (!toks.length) return { measured: false, reason: 'no-query-keywords', checked: 0 };
  var latin = list.filter(function (t) {
    return (t.match(/[a-z]/gi) || []).length >= 3 && !/[\u0590-\u05ff\u0600-\u06ff\u0400-\u04ff]{2}/.test(t);
  });
  if (!list.length || latin.length * 2 < list.length) {
    return { measured: false, reason: list.length ? 'titles-not-latin' : 'no-titles', checked: 0, keywords: toks };
  }
  /* Latin script is not English: a Spanish or German account's titles
   * ("Ratón inalámbrico para PC", "Kabellose Maus mit USB") cannot match
   * English keywords either. Their function words give them away. Six of
   * them are English words too ("Pour Over Kettle", "Les Paul", "Con Rod"),
   * so one of those counts only beside a second one or a letter with an
   * accent. Alone, "pour" used to turn the whole check off (review,
   * 2026-10-18). */
  var FOREIGN = /(^|[^a-z])(und|mit|für|avec|sans|por|une|della|voor|och)([^a-z]|$)/i;
  var FOREIGN_TOO = /(^|[^a-z])(para|con|pour|les|des|sin)(?=[^a-z]|$)/gi;
  var ACCENT = /[\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u017f]/;
  var isForeign = function (t) {
    if (FOREIGN.test(t)) return true;
    var seen = [];
    (t.match(FOREIGN_TOO) || []).forEach(function (m) {
      var w = m.toLowerCase().replace(/[^a-z]/g, '');
      if (seen.indexOf(w) < 0) seen.push(w);
    });
    return seen.length >= 2 || (seen.length === 1 && ACCENT.test(t));
  };
  var foreign = latin.filter(isForeign).length;
  if (foreign * 10 >= latin.length * 3) {
    return { measured: false, reason: 'titles-not-english', checked: 0, keywords: toks };
  }
  /* One word for its simple forms. Each word gives a few bases, and two
   * words match when they share one. One stem per word missed "toy" and
   * "toys", "box" and "boxes", "dress" and "dresses" (review, 2026-10-18).
   *   plurals: toys, cars, ties, boxes, buses, dresses, cables, knives, mice
   *   -er/-ing/-ed: charger, charging. That base keeps 4+ letters, so
   *     "wired" is never "wire".
   *   -ier/-ying: magnifier, magnifying
   * A word ending in -ss keeps its last s: "dress" is not "dres".
   * "-es" comes off only after s, x, z, ch, sh or o (boxes, dresses,
   * watches, heroes). After any other letter only the "s" comes off:
   * "tubes" is "tube", never "tub", and "tapes" is never "tap". A plain
   * "-s" comes off only when 3 letters stay: "ups" is not "up" (recheck,
   * 2026-10-19: the -es rule had been widened to every word).
   * A shared PREFIX is not a shared word: "water" and "waterproof",
   * "table" and "tablet" used to match (review, 2026-10-18). */
  var IRREGULAR = { mice: 'mouse', men: 'man', women: 'woman', feet: 'foot', teeth: 'tooth', children: 'child', geese: 'goose' };
  var bases = function (w) {
    var out = [];
    var add = function (b) {
      if (b.length < 2) return;
      b = b.replace(/i$/, 'y');
      if (out.indexOf(b) < 0) out.push(b);
    };
    add(w);
    if (has(IRREGULAR, w)) add(IRREGULAR[w]);
    if (w.length > 5 && /ives$/.test(w)) add(w.slice(0, -4) + 'ife');
    if (w.length > 5 && /ves$/.test(w)) add(w.slice(0, -3) + 'f');
    if (w.length > 4 && /ies$/.test(w)) add(w.slice(0, -3) + 'y');
    if (w.length > 5 && /ying$/.test(w)) add(w.slice(0, -4) + 'y');
    if (w.length > 4 && /(s|x|z|ch|sh|o)es$/.test(w)) add(w.slice(0, -2));
    if (w.length > 3 && /[^s]s$/.test(w)) add(w.slice(0, -1));
    var m = w.match(/^(.{4,}?)(ings|ing|ers|er|ed)$/);
    if (m) add(m[1]);
    // "magnetic" is "magnet" (the user's own query "oxyled fridge magnet
    // light motion" over "Magnetic" titles, review 2026-10-20). 6+ letters
    // stay, so "organic" is never "organ" and "plastic" never "plast".
    if (w.length > 7 && /ic$/.test(w)) add(w.slice(0, -2));
    // A UK form also gives its US form, after the plural and -er/-ing
    // stems: "Organisers" holds "organizer" (CR-1, review 2026-10-20).
    out.slice().forEach(function (b) { if (has(UK, b)) add(UK[b]); });
    return out;
  };
  var meets = function (xs, ys) { return xs.some(function (x) { return ys.indexOf(x) >= 0; }); };
  // Prototype-free maps: a query word like "constructor" is never held by
  // every title through Object.prototype (F6, review 2026-10-19).
  var kb = Object.create(null);
  // A title that writes "TypeC" or "USBC" as one word holds "type" / "usb"
  // (CR-2, review 2026-10-20: the query split had lost that match).
  toks.forEach(function (k) { kb[k] = bases(k); if (k === 'type' || k === 'usb') kb[k].push(k + 'c'); });
  // Two query keywords side by side are one word too: "screw driver" is
  // held by a title that says "Screwdriver".
  var pairs = [];
  for (var qi = 0; qi + 1 < qwords.length; qi++) {
    if (toks.indexOf(qwords[qi]) >= 0 && toks.indexOf(qwords[qi + 1]) >= 0) {
      pairs.push({ a: qwords[qi], b: qwords[qi + 1], bs: bases(qwords[qi] + qwords[qi + 1]).concat(bases(us(qwords[qi]) + us(qwords[qi + 1]))) });
    }
  }
  /* For rule 1 only: connector goods have a small, closed set of names. A
   * title that names the same goods in other words ("Cord" for "cable",
   * "Earbuds" for "earpods", "Pendrive" for "stick") holds that keyword for
   * rule 1 (FA2-1, FA2-3, FA2-5, review 2026-10-20). The share rule and
   * rule 2 do not use this table. "iem" is in no class, so "type c iem"
   * over cables still warns. */
  var GOODS = [['cable', 'cord', 'lead', 'wire', 'line'], ['charger', 'plug', 'brick', 'block', 'puck'],
    ['adapter', 'adaptor', 'converter', 'connector'],
    ['hub', 'splitter', 'multiport', 'expander', 'extender', 'dock', 'docking'],
    ['dongle', 'adapter', 'converter', 'hub', 'splitter', 'multiport', 'dock', 'docking'],
    ['switch', 'switcher', 'selector', 'multiplexer'], ['wallet', 'purse', 'billfold', 'cardholder'],
    ['grip', 'popsocket', 'socket', 'kickstand'],
    ['stick', 'pendrive', 'drive', 'key', 'disk', 'storage', 'memory'],
    ['earphones', 'earbuds', 'headphones', 'earpods', 'airpods', 'buds', 'earpiece', 'handsfree', 'headset'],
    ['cam', 'camera', 'webcam'], ['mic', 'microphone'], ['joypad', 'gamepad', 'controller', 'joystick']];
  var goodsOf = Object.create(null);
  toks.forEach(function (k) {
    if (CONNECTOR.test(k)) return;
    for (var gi = 0; gi < GOODS.length; gi++) {
      var gb = [].concat.apply([], GOODS[gi].map(bases));
      if (meets(kb[k], gb)) { goodsOf[k] = gb; break; }
    }
  });
  var perGoods = Object.create(null);
  // Titles that are a plug's own goods: cables, chargers, adapters.
  var CABLE_GOODS = /^(cables?|cords?|leads?|wires?|line|chargers?|charging|adapters?|adaptors?|converters?|plugs?|bricks?)$/;
  var cableGoods = 0;
  var per = Object.create(null);
  toks.forEach(function (k) { per[k] = 0; perGoods[k] = 0; });
  var on = 0;
  var off = [];
  var gots = [];
  latin.forEach(function (t) {
    var ws = words(t);
    // ... and two title words side by side: "Screw Driver" is "screwdriver".
    // Not a one-letter word or a bare ending: "Copper Wire D Ring" does not
    // hold "wired", and "Car T Shirt" does not hold "cart" (recheck,
    // 2026-10-19). A join must never undo the "wire is not wired" rule.
    var all = ws.slice();
    for (var wi = 0; wi + 1 < ws.length; wi++) {
      if (ws[wi].length >= 2 && ws[wi + 1].length >= 2 && !/^(ed|er|es|ers|ing|ings)$/.test(ws[wi + 1])) {
        all.push(ws[wi] + ws[wi + 1]);
        all.push(us(ws[wi]) + us(ws[wi + 1]));
      }
    }
    var wb = all.map(bases);
    var got = Object.create(null);
    toks.forEach(function (k) { if (wb.some(function (b) { return meets(b, kb[k]); })) got[k] = true; });
    pairs.forEach(function (p) { if (wb.some(function (b) { return meets(b, p.bs); })) { got[p.a] = true; got[p.b] = true; } });
    toks.forEach(function (k) { if (got[k] || (goodsOf[k] && wb.some(function (b) { return meets(b, goodsOf[k]); }))) perGoods[k]++; });
    var hit = false;
    toks.forEach(function (k) { if (got[k]) { per[k]++; hit = true; } });
    gots.push(got);
    if (ws.some(function (w) { return CABLE_GOODS.test(w); })) cableGoods++;
    if (hit) on++;
    else if (off.length < 3) off.push(t.slice(0, 60));
  });
  var r3 = function (x) { return Math.round(x * 1000) / 1000; };
  var keywordShare = {};
  toks.forEach(function (k) { keywordShare[k] = r3(per[k] / latin.length); });
  var share = on / latin.length;
  var warn = latin.length >= 5 && share < 0.5;
  // The connector words of the query, and the keywords that are not one.
  var conn = toks.filter(function (k) { return CONNECTOR.test(k); });
  var rest = toks.filter(function (k) { return conn.indexOf(k) < 0; });
  var under = function (k, cut) { return per[k] < cut * latin.length; };
  // Rule 1: a connector word carried the share (it is in half the titles
  // or more, CR-6), and every other keyword, read with its goods class, is low.
  /* A query whose other words are all specs with a digit ("usb c 2m",
   * "type c 120w") names no goods, so a page of cables and chargers is its
   * product. Measured 2026-10-20: titles that are cables, chargers or
   * adapters were 37% of the junk page served for "usb c 100w", and 71% to
   * 100% of real cable pages. A query with a noun ("iem", "dock") is never
   * let off this way: the lightning and thunderbolt cable pages are 92% to
   * 94% cables and still warn. */
  var specOnly = rest.length > 0 && rest.every(function (k) { return /\d/.test(k); });
  var connAlone = latin.length >= 5 && !warn && rest.length > 0 &&
    conn.some(function (k) { return !under(k, 0.5); }) &&
    rest.every(function (k) { return perGoods[k] < CONNECTOR_ALONE * latin.length; }) &&
    !(specOnly && cableGoods >= 0.6 * latin.length);
  // Rule 2: 3 or more keywords, and more than half, are all but absent.
  // Connector words are left out of this count when the query has others.
  var counted = rest.length ? rest : toks;
  var missing = counted.filter(function (k) { return under(k, MISSING); });
  var thin = latin.length >= 5 && !warn && !connAlone && missing.length >= 3 && missing.length * 2 > counted.length;
  var lacking = connAlone ? rest : missing;
  // Held: counted keywords in 5% of the titles or more (CR-7).
  var held = counted.filter(function (k) { return missing.indexOf(k) < 0; });
  var carrier = conn.filter(function (k) { return !under(k, 0.5); });
  if (connAlone || thin) {
    // Titles to read: ones that hold none of the lacking keywords.
    off = [];
    for (var ti = 0; ti < latin.length && off.length < 3; ti++) {
      var g = gots[ti];
      if (!lacking.some(function (k) { return g[k]; })) off.push(latin[ti].slice(0, 60));
    }
  }
  var pct = function (x) { return Math.round(x * 100) + '%'; };
  var tail = ' Read them first. If they are the product, the stream is fine (coverage.streamVerdict). If not, ' +
    'this is NOT a harvest of the product: do not report it as exhausted-all-results. Re-word the query ' +
    'and say so to the user.';
  return {
    measured: true, keywords: toks, keywordShare: keywordShare,
    connectorKeywords: conn, missingKeywords: missing,
    checked: latin.length, onQuery: on, share: r3(share),
    offSample: off,
    warning: warn
      ? 'off-query-results: only ' + on + ' of ' + latin.length + ' titles hold any of the keywords [' +
        toks.join(', ') + ']. Titles that hold none: ' + JSON.stringify(off) + '. Read them first: this ' +
        'check cannot see a synonym ("earbuds" for "earphones"). If they are the product, the stream is ' +
        'fine (coverage.streamVerdict). If the site served another category, this is NOT a complete ' +
        'harvest of the product: do not report it as exhausted-all-results. Re-word the query and say so ' +
        'to the user.'
      : connAlone
        ? 'off-query-connector: the titles matched on the connector word [' + carrier.join(', ') + '], and every ' +
          'other keyword [' + rest.join(', ') + '] is in fewer than ' + pct(CONNECTOR_ALONE) + ' of the ' + latin.length +
          ' titles. Cables, chargers, hubs and flash drives all carry a connector word (live 2026-10-19: "type c ' +
          'iem" was served as USB-C cables). Titles: ' + JSON.stringify(off) + '.' + tail
        : thin
          ? 'off-query-keywords: ' + missing.length + ' of the ' + counted.length + ' keywords' +
            (conn.length && rest.length ? ' that are not connector words' : '') + ' [' + missing.join(', ') +
            '] are each in fewer than ' + pct(MISSING) + ' of the ' + latin.length + ' titles, so the stream matched ' +
            (held.length ? 'on [' + held.join(', ') + '] alone' : 'on no keyword in ' + pct(MISSING) + ' of the titles or more') +
            '. A brand or model word can carry a whole other category (live ' +
            '2026-10-19: "poco f7 ultra wallet case" was served as POCO phones). Titles: ' + JSON.stringify(off) +
            '.' + tail
          : null,
  };
}
/* @shared:queryRelevance:end */

  /* Visible-ish text of a fetched page: the HTML without scripts, styles and
   * tags. wallVerdict's "big HTML, no content" rule compares HTML size with
   * TEXT size. Passing the HTML as the text (as this file used to) made the
   * two equal, so a large quiet interstitial with no "punish" string could
   * never be called a suspected wall and was reported as a parse-error. */
  // The slider wall's own sentences (the same list as listing.js and
  // extract.js). Not "please slide" alone: product titles use it.
  const STRONG_WALL = /unusual traffic|slide to verify|(להחליק|החלק|גרור|המחוון)[^.]{0,40}(לאמת|אימות)/i;
  function pageText(html) {
    return String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  /* BACKUP. A harvest lives only in this tab's `window`. send() falls back to
   * a form POST, which is a navigation, and a hung fetch can force the tab
   * closed: either way the harvest was gone (measured 2026-10-17, lost
   * twice: the receiver had exited, send() posted the form to the dead port,
   * and the tab went to chrome-error://). So the state is written to
   * localStorage after every page and before any form POST. localStorage
   * belongs to the origin, not the tab: a fresh tab on he.aliexpress.com can
   * call restore() and carry on from the next unread page. */
  const BACKUP_PREFIX = '__aeHarvest:';
  /* One key per RUN: prefix + slug + ':' + start time. A key per query let
   * restore() hand back an older run of the same query (other filters,
   * already exhausted) when the current run had not saved yet, and a key
   * nobody deleted stayed forever. Only the MAX_BACKUPS runs SAVED last are
   * kept, and when the store is full the runs saved longest ago are dropped
   * and the save is tried once more (review of the fix, 2026-10-18). */
  const MAX_BACKUPS = 3;
  function storage() {
    try { return window.localStorage || null; } catch (e) { return null; }
  }
  const FIELDS = ['query', 'slug', 'base', 'fourStar', 'extra', 'startPage', 'maxPages', 'maxRequests',
    'page', 'requests', 'items', 'pages', 'claimedTotal', 'stop', 'endSignal', 'lastErr', 'wall', 'startedAt'];
  const keyOf = (st) => BACKUP_PREFIX + st.slug + ':' + Number(st.startedAt || 0).toString(36);
  const parseKey = (k) => {
    const rest = k.slice(BACKUP_PREFIX.length);
    const at = rest.lastIndexOf(':');
    return at < 0 ? { slug: rest, stamp: 0 } : { slug: rest.slice(0, at), stamp: parseInt(rest.slice(at + 1), 36) || 0 };
  };
  function backupKeys() {
    const ls = storage();
    const out = [];
    if (!ls) return out;
    try {
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (k && k.indexOf(BACKUP_PREFIX) === 0) out.push(k);
      }
    } catch (e) { /* storage blocked */ }
    /* Saved last first, not started last (review, 2026-10-18): the start
     * stamp made an older run that was restored and read on count as the
     * oldest. restore() then handed back another run, and prune() deleted
     * the one being worked on. persist() writes "savedAt" as the second
     * field; an entry without it falls back to its start stamp. */
    const savedAt = (k) => {
      let text = '';
      try { text = String(ls.getItem(k) || ''); } catch (e) { text = ''; }
      const m = /"savedAt":(\d+)/.exec(text);
      return m ? Number(m[1]) : parseKey(k).stamp;
    };
    const at = new Map(out.map((k) => [k, savedAt(k)]));
    return out.sort((x, y) => (at.get(y) - at.get(x)) || (parseKey(y).stamp - parseKey(x).stamp));
  }
  function prune(ls, keepKey, max) {
    let kept = 0;
    for (const k of backupKeys()) {
      if (k === keepKey) continue;
      if (kept < max - 1) { kept++; continue; }
      try { ls.removeItem(k); } catch (e) { /* ignore */ }
    }
  }
  function persist(st) {
    const ls = storage();
    if (!ls) return { ok: false, err: 'localStorage unavailable' };
    const o = { v: 2, savedAt: Date.now() };
    FIELDS.forEach((k) => { o[k] = st[k]; });
    const text = JSON.stringify(o);
    const key = keyOf(st);
    /* When the store is FULL, older runs are dropped one at a time, oldest
     * first, until this one fits. Any other error drops nothing (it used to
     * delete every other backup first). If this run still cannot be saved,
     * its OWN older save is removed too: restored, it would hold fewer pages
     * and fewer requests than were spent, and say restored:true (review,
     * 2026-10-18). status().backup then says saved:false: send() at once. */
    const quota = (e) => /quota/i.test(String(e && e.name) + ' ' + String(e && e.message));
    let saved = false, lastErr = null;
    for (let tries = 0; tries < 12 && !saved; tries++) {
      try { ls.setItem(key, text); saved = true; } catch (e) {
        lastErr = e;
        if (!quota(e)) break;
        const older = backupKeys().filter((k) => k !== key);
        if (!older.length) break;
        try { ls.removeItem(older[older.length - 1]); } catch (e2) { break; }
      }
    }
    if (!saved) {
      try { ls.removeItem(key); } catch (e) { /* ignore */ }
      return { ok: false, err: noQ(String(lastErr)).slice(0, 100) };
    }
    prune(ls, key, MAX_BACKUPS);
    return { ok: true, key, chars: text.length, items: st.items.length };
  }
  /* A number, or a string of digits. '', ' ', false and [] are refused:
   * Number() turns each of them into 0, a silent zero budget. */
  /* No "?" in anything returned: the Chrome connector blocks a result that
   * looks like it holds a query string, and a JSON error message can quote
   * one ("...?x=1"...). */
  const noQ = (x) => String(x == null ? '' : x).split('?').join('%3F');
  const filterKey = (st) => {
    let h = 5381;
    const t = (st.fourStar === false ? '0' : '4') + '|' + (st.extra || '');
    for (let k = 0; k < t.length; k++) h = ((h * 33) ^ t.charCodeAt(k)) >>> 0;
    return h.toString(36);
  };
  const num = (v, dflt, name) => {
    if (v == null) return dflt;
    const ok = (typeof v === 'number' && Number.isInteger(v) && v >= 0) ||
               (typeof v === 'string' && /^\s*\d+\s*$/.test(v));
    if (!ok) throw new Error('harvest: ' + name + ' must be a whole number >= 0, got ' + JSON.stringify(v));
    return Number(v);
  };
  /* The last page the site serves (measured 2026-08-21: "page 60 is the
   * hard ceiling"). maxPages used to go past it, and the empty page 61 then
   * ended the run as exhausted-all-results although the site had only
   * stopped serving (review, 2026-10-18). A higher maxPages is cut to it
   * with a note, a run that reaches it stops as page-cap (truncated), and
   * page 61 is never fetched. What the site serves past 60 was not measured
   * again. */
  const LAST_PAGE = 60;
  const capNote = (n) => 'maxPages ' + n + ' cut to ' + LAST_PAGE + ': the site serves no page past ' + LAST_PAGE;
  /* What restore() says about a saved stop. The stop comes back with the
   * harvest, and step() reads nothing while a stop is set: SKILL.md said
   * step(6) carries on after restore(), and a restored wall stop made no
   * request at all (recheck 2026-10-18, F06). So the reply names the call
   * that clears it. No stop, no note. Short: a suspect-wall reply carries
   * the wall verdict too, and Chrome cuts a result at 1,000 characters. */
  const restoreNote = (st) => {
    const s = st.stop;
    if (!s) return null;
    if (s === 'exhausted') return 'stop exhausted: nothing is left to read. Export it';
    if (s === 'page-cap' && st.page >= LAST_PAGE) return 'stop page-cap at page ' + LAST_PAGE + ': nothing is left to read. Export it';
    const lift = s === 'request-budget' ? 'resume({ maxRequests })' : (s === 'page-cap' ? 'resume({ maxPages })' : 'resume()');
    return 'stop ' + s + ': step() reads nothing until ' + lift +
           (s === 'blocked' || s === 'suspect-wall' ? '. A wall: Step 2 first' : '');
  };

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

  /* 'visible', 'hidden' or 'unknown'. Reported by status() because a hidden
   * tab changes what works (measured 2026-09-29, Chrome connector): a
   * 100 ms setTimeout fired after 958 ms, a 2,500 ms one had not fired 45 s
   * later, and screenshots, zoom and get_page_text each hung until the 45 s
   * tool timeout. javascript_tool and fetch() kept working. Chrome marks a
   * tab hidden when its window is minimised or fully covered. */
  function visibility() {
    try {
      const d = window.document;
      return d && typeof d.visibilityState === 'string' ? d.visibilityState : 'unknown';
    } catch (e) { return 'unknown'; }
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
     *   maxPages    default 20   the LAST page number read. AliExpress
     *               serves no page past 60: a higher value is cut to 60 and
     *               the plan says so in `note`
     *   maxRequests default 24   (the wall tripped near 50-60 in a session).
     *               0 means "no request left": it is NOT replaced by the
     *               default (it used to be, so a fully spent budget became 24)
     *   startPage   default 1    first page to fetch. A recovery harvest that
     *               cannot restore() starts after the pages already saved,
     *               instead of spending its budget on them again. Above 60
     *               it is refused: there is nothing to read there
     *   extra       raw extra query string, e.g. '&shpf_co=CN' or
     *               '&attr=11795-4362329' (attribute ids come from the
     *               searchRefineFilters module — see SKILL.md step 1)
     *
     * Refused while a step() loop runs: a second state would start a second
     * loop beside the first, both fetching, and only one counted.
     */
    start(opts) {
      opts = opts || {};
      if (this.st && this.st.running) {
        throw new Error('harvest: a step() loop is still running. Poll status() until running is false, then start().');
      }
      const slug = slugify(opts.query);
      if (!slug) throw new Error('harvest: opts.query is required (English keywords)');
      let maxPages = num(opts.maxPages, 20, 'maxPages');
      const maxRequests = num(opts.maxRequests, 24, 'maxRequests');
      const startPage = Math.max(1, num(opts.startPage, 1, 'startPage'));
      if (startPage > LAST_PAGE) {
        throw new Error('harvest: startPage ' + startPage + ' is past page ' + LAST_PAGE + ', the last page the site serves');
      }
      const note = maxPages > LAST_PAGE ? capNote(maxPages) : null;
      if (note) maxPages = LAST_PAGE;
      let base = 'https://he.aliexpress.com/w/wholesale-' + slug +
                 '.html?SortType=total_tranpro_desc';
      if (opts.fourStar !== false) base += '&selectedSwitches=filterCode%3A4StarRating';
      if (opts.extra) base += opts.extra;
      this.st = {
        query: opts.query, slug, base,
        fourStar: opts.fourStar !== false,
        extra: opts.extra || null,
        startPage, maxPages, maxRequests,
        page: startPage - 1, requests: 0,
        seen: new Set(), items: [], pages: [],
        claimedTotal: null, stop: null, endSignal: null, lastErr: null, wall: null,
        running: false, backup: null, startedAt: Date.now(),
      };
      // Saved at once, so a hang on page 1 can never leave an older run of
      // this query as the backup saved last.
      this.st.backup = persist(this.st);
      /* No query string in anything returned to the operator. The Chrome
       * connector replaces a whole result with "[BLOCKED: Cookie/query string
       * data]" when it contains one (measured 2026-09-14); the in-app browser
       * does not care. debugUrl() has the full URL for the in-app browser. */
      return Object.assign({ query: this.st.query,
               searchPath: '/w/wholesale-' + slug + '.html',
               sort: 'total_tranpro_desc', fourStar: this.st.fourStar,
               extraApplied: !!this.st.extra,
               startPage, maxPages, maxRequests }, note ? { note } : {});
    },

    /* Reload a harvest saved in localStorage (see BACKUP above), in this tab
     * or a fresh one on the same origin. With no query, the run SAVED last
     * is taken (not the one started last). The state comes back as it was
     * saved: items, pages read,
     * requests spent and the stop reason, so step() carries on from the next
     * unread page and the request budget keeps counting. A saved stop comes
     * back too: then step() reads nothing until resume() clears it, and the
     * reply's `note` says so (see restoreNote). */
    restore(query) {
      if (this.st && this.st.running) return { err: 'a step() loop is running; wait until status().running is false' };
      const ls = storage();
      if (!ls) return { err: 'localStorage unavailable: no backup can exist in this page' };
      let best = null;
      for (const k of backupKeys()) { // saved last first
        if (query && parseKey(k).slug !== slugify(query)) continue;
        let o = null;
        try { o = JSON.parse(ls.getItem(k)); } catch (e) { continue; }
        if (o && Array.isArray(o.items)) { best = o; break; }
      }
      if (!best) return { err: 'no harvest backup' + (query ? ' for "' + query + '"' : ''), backups: this.backups() };
      const st = { running: false, backup: null, seen: new Set() };
      FIELDS.forEach((k) => { st[k] = best[k]; });
      st.startPage = st.startPage || 1;
      st.startedAt = st.startedAt || best.savedAt || 0;
      st.pages = st.pages || [];
      st.items.forEach((i) => st.seen.add(String(i.id)));
      this.st = st;
      const note = restoreNote(st);
      return Object.assign(this.status(), {
        restored: true, savedAt: new Date(best.savedAt || 0).toISOString(),
      }, note ? { note } : {});
    },

    /* Saved harvests in localStorage, saved last first. No URL, no query string. */
    backups() {
      const ls = storage();
      if (!ls) return [];
      const out = [];
      for (const k of backupKeys()) {
        try {
          const o = JSON.parse(ls.getItem(k));
          out.push({ query: o.query, items: (o.items || []).length, pagesRead: o.page, requests: o.requests,
                     stop: o.stop, fourStar: o.fourStar, extraApplied: !!o.extra,
                     savedAt: new Date(o.savedAt || 0).toISOString() });
        } catch (e) { out.push({ query: parseKey(k).slug, err: 'unreadable' }); }
      }
      return out; // saved last first, at most MAX_BACKUPS
    },

    /* Delete a backup once its payload is safely on disk. */
    dropBackup(query) {
      const ls = storage();
      if (!ls || !query) return 'nothing dropped';
      let n = 0;
      for (const k of backupKeys()) {
        if (parseKey(k).slug !== slugify(query)) continue;
        try { ls.removeItem(k); n++; } catch (e) { return 'drop failed: ' + String(e).slice(0, 80); }
      }
      return n ? 'dropped ' + n + ' backup(s) for "' + query + '"' : 'no backup for "' + query + '"';
    },

    /* Clear a stop so step() can go on with the items kept. Before this a
     * stop was final, so after a cleared wall or one transient fetch error the
     * only way on was start(), which threw the harvest away and spent requests
     * re-reading it. 'exhausted' is a real end and is not cleared. A raised
     * maxRequests / maxPages is taken here, so a 'request-budget' or
     * 'page-cap' stop can be lifted on purpose, up to page 60 (LAST_PAGE).
     * The page that hit the wall was not counted, so it is fetched again. */
    resume(opts) {
      const s = this.st;
      if (!s) return { err: 'call start() or restore() first' };
      if (s.running) return Object.assign(this.status(), { err: 'step() is already running' });
      opts = opts || {};
      s.maxRequests = num(opts.maxRequests, s.maxRequests, 'maxRequests');
      s.maxPages = num(opts.maxPages, s.maxPages, 'maxPages');
      const note = s.maxPages > LAST_PAGE ? capNote(s.maxPages) : null;
      if (note) s.maxPages = LAST_PAGE;
      if (s.stop === 'exhausted') {
        return Object.assign(this.status(), { err: 'the stream already ran dry (exhausted): nothing to resume' });
      }
      if (s.stop === 'page-cap' && s.page >= LAST_PAGE) {
        return Object.assign(this.status(), { err: 'page ' + LAST_PAGE + ' was read and the site serves no page past it: ' +
          'nothing to resume. The stream verdict stays truncated.' }, note ? { note } : {});
      }
      const was = s.stop;
      s.stop = null; s.wall = null; s.lastErr = null;
      return Object.assign(this.status(), { resumed: was, nextPage: s.page + 1 }, note ? { note } : {});
    },

    /* The full first-page URL. In-app browser only: the Chrome connector
     * blocks this output because of the query string. */
    debugUrl() {
      return this.st ? this.st.base + '&page=1' : null;
    },

    /* Make the LOGGED-OUT storefront serve English pages while keeping the
     * region's currency. Sets the three cookies the site's own language panel
     * writes (verified 2026-09-14: page lang "en", ILS prices, JSON-LD
     * unchanged, host stays he.aliexpress.com). Fetches made after this call
     * carry the cookies, so the harvest comes back with English titles.
     *
     * NEVER call this in a signed-in browser (the Chrome connector): it would
     * overwrite the account's own language/currency settings. Parse whatever
     * locale a signed-in account uses instead — SOLD_RE accepts both. */
    forceEnglish(opts) {
      opts = opts || {};
      const cur = opts.currency || 'ILS';
      const region = opts.region || 'IL';
      const doc = window.document;
      const exp = 'expires=' + new Date(Date.now() + 365 * 864e5).toUTCString();
      const tail = '; domain=.aliexpress.com; path=/; ' + exp;
      doc.cookie = 'aep_usuc_f=site=glo&c_tp=' + cur + '&region=' + region + '&b_locale=en_US' + tail;
      doc.cookie = 'xman_us_f=x_locale=en_US&x_l=0&x_c_chg=1&intl_locale=en_US' + tail;
      doc.cookie = 'intl_locale=en_US' + tail;
      return 'english-cookies-set (' + cur + '/' + region + '); later fetches and page loads are English';
    },

    /* PRIMARY export, both browsers: POST the payload to scripts/receiver.mjs
     * on loopback, which writes it to disk and replies with the path. Start
     * the receiver first:
     *   node scripts/receiver.mjs --dir <outdir> --port 8765
     *
     * Two transports (measured 2026-09-14, Chrome 153):
     *   fetch()  — held indefinitely by Chrome's local-network permission
     *              gate when the page is a public https site: the request
     *              never reached the receiver in 45 s. Raced against a short
     *              timeout.
     *   form     — a top-level <form method=POST enctype=text/plain> to the
     *              same URL is a navigation, not a subresource request, and
     *              it DID reach the receiver. Window state is gone after the
     *              navigation.
     *
     * The return value starts with the outcome, so it cannot be misread:
     *   DELIVERED      the receiver answered "saved <path>" to the fetch.
     *   NOT DELIVERED  nothing left the page, and it did NOT navigate: the
     *                  fetch was refused (no receiver on the port) or the
     *                  receiver rejected the body. The harvest is still here.
     *   UNCONFIRMED    the form was posted (fetch held, tab hidden, or
     *                  via:'form'). Only the receiver's own output can say
     *                  "saved". The state was written to localStorage first,
     *                  so if nothing was saved, restore() brings it back.
     *
     * via:'form' (what SKILL.md tells the operator to use, since both
     * browsers refused the loopback fetch on 2026-10-18) never tries the
     * fetch. It always posts the form, so it navigates even to a dead port,
     * visible tab or hidden: the curl check before send() is the only guard,
     * and restore() is the way back (recheck 2026-10-18, F05).
     *
     * WHY (measured 2026-10-17): a refused fetch used to fall through to the
     * form, exactly like a held one. With the receiver gone (it had exited
     * after its one payload), the form navigated to a dead port, the tab went
     * to chrome-error:// and the harvest was lost, twice, while the return
     * said "form-posted …" as if all was well. A refused connection needs no
     * navigation to prove: the fetch already answered.
     *
     * A HIDDEN tab skips the fetch race in 'auto' mode: the race needs a
     * timer, and a hidden tab delays timers past the 45 s tool limit (see
     * visibility()). The form needs no timer. Its reply page cannot be read
     * there (get_page_text hangs on a hidden tab), so read the saved path
     * from the receiver's own output.
     *
     * No form is posted when the backup could not be written, unless
     * opts.force is true: the navigation would be the only copy's end.
     * The return value has no query string, so the Chrome connector shows it. */
    async send(port, opts) {
      opts = opts || {};
      const host = opts.host || '127.0.0.1';
      const url = 'http://' + host + ':' + (port || 8765) + '/harvest';
      const p = this.payload();
      const via = opts.via || 'auto';
      const hidden = visibility() === 'hidden';
      let fetchNote = '';
      if (via === 'fetch' || (via === 'auto' && !hidden)) {
        const timeoutMs = opts.timeoutMs || 3000;
        const attempt = fetch(url, { method: 'POST', mode: 'cors', headers: { 'Content-Type': 'text/plain' }, body: p })
          .then(async (r) => ({ status: r.status, text: String(await r.text()).slice(0, 400) }))
          .catch((e) => ({ error: String(e).slice(0, 120) }));
        const held = new Promise((resolve) => setTimeout(() => resolve({ held: true }), timeoutMs));
        const res = await Promise.race([attempt, held]);
        if (res.status != null) {
          const saved = res.status === 200 && /^saved /.test(res.text);
          return (saved ? 'DELIVERED: ' : 'NOT DELIVERED: ') + 'sent ' + p.length + ' chars; receiver replied ' +
                 res.status + ': ' + res.text + (saved ? '' : ' - the harvest is still in this tab; fix the cause and send() again');
        }
        if (res.error) {
          if (via === 'fetch') return 'NOT DELIVERED: FETCH-ERROR ' + res.error;
          return 'NOT DELIVERED: FETCH-ERROR ' + res.error + ' - nothing is listening on port ' + (port || 8765) +
                 ', or the browser refused the request. The page did NOT navigate: the harvest is still here. ' +
                 'Check the receiver: curl -s http://127.0.0.1:' + (port || 8765) + '/ must answer "ok". If it does, ' +
                 'the browser blocks loopback fetches (the in-app browser always does, and signed-in Chrome did on 2026-10-18): send(' + (port || 8765) +
                 ', {via:"form"}) posts the form instead.';
        }
        // Still in flight: it may land later, so this is not "not delivered".
        if (via === 'fetch') {
          return 'UNCONFIRMED: FETCH-HELD after ' + timeoutMs + ' ms - the request is still pending and may still ' +
                 'arrive: check the receiver output for "saved <path>" before sending again';
        }
        fetchNote = ' (fetch held ' + timeoutMs + ' ms)';
      }
      const bk = this.st ? persist(this.st) : { ok: false, err: 'not started' };
      if (this.st) this.st.backup = bk;
      if (!bk.ok && !opts.force) {
        // A held fetch is still in flight and may yet land: not "not delivered".
        return (fetchNote ? 'UNCONFIRMED: the fetch is held and may still arrive - check the receiver output for ' +
                            '"saved <path>" first; ' : 'NOT DELIVERED: ') +
               'no form posted, because the localStorage backup failed (' + bk.err + ') and the ' +
               'navigation would lose the only copy. Export with expose() (visible tab), or pass {force:true}.';
      }
      const doc = window.document;
      const f = doc.createElement('form');
      f.method = 'POST'; f.action = url; f.enctype = 'text/plain';
      const ta = doc.createElement('textarea');
      ta.name = 'payload'; ta.value = p;
      f.appendChild(ta);
      doc.body.appendChild(f);
      f.submit();
      return 'UNCONFIRMED: form-posted ' + p.length + ' chars to ' + url + fetchNote +
             (hidden ? ' (tab hidden: fetch skipped)' : '') +
             (bk.ok ? '; backup saved (' + bk.items + ' items)' : '; NO backup (' + bk.err + ')') +
             ' - delivered only if the receiver prints "saved <path>" in its own output: read it there' +
             (hidden ? ' (get_page_text hangs on a hidden tab)' : ', or with get_page_text on this tab') +
             '. If it printed nothing, navigate back to AliExpress, install harvest.js and call __aeHarvest.restore()';
    },

    /* FALLBACK export for the Chrome connector when loopback is unreachable.
     * Its javascript_tool cuts every result at 1,000 characters (measured
     * 2026-09-14) and get_page_text at 50,000, so: write one chunk of the
     * payload into a <pre> that is the FIRST child of <body> (page text after
     * it may be cut, the chunk never is), read it with get_page_text, repeat
     * for each chunk, then reassemble with scripts/decode.mjs.
     *
     * The in-app browser has its own fallback: an oversized payload() result
     * is saved to a file by the harness, and decode.mjs reads that file. */
    chunks(size) {
      const p = this.payload();
      const n = size || 40000;
      return { total: p.length, chunkSize: n, count: Math.ceil(p.length / n) };
    },

    expose(i, size) {
      const doc = window.document;
      const n = size || 40000;
      const p = this.payload();
      const count = Math.ceil(p.length / n);
      const idx = i || 0;
      /* The marker names the payload by a hash of its text. Two exports
       * (the stuck tab's and the recovery tab's) used to share markers
       * "AEPAYLOAD 0/2", and decode.mjs let one overwrite the other with
       * exit 0. A payload that changed between two chunks gets another id,
       * so its chunks can never be stitched together either. */
      let h = 5381;
      for (let k = 0; k < p.length; k++) h = ((h * 33) ^ p.charCodeAt(k)) >>> 0;
      const id = h.toString(36);
      let el = doc.getElementById('__aePayload');
      if (!el) { el = doc.createElement('pre'); el.id = '__aePayload'; }
      el.textContent = 'AEPAYLOAD ' + idx + '/' + count + ' ' + id + ' START\n' +
                       p.slice(idx * n, (idx + 1) * n) + '\nAEPAYLOAD END';
      el.setAttribute('style',
        'position:absolute;left:0;top:0;font-size:1px;white-space:pre-wrap;word-break:break-all;');
      if (doc.body.firstChild !== el) doc.body.insertBefore(el, doc.body.firstChild);
      return 'exposed chunk ' + idx + '/' + count + ' of payload ' + id + ' (' +
             Math.max(0, Math.min(n, p.length - idx * n)) + ' chars) - read it with get_page_text';
    },

    /* Fetch up to n more pages. Safe to call repeatedly; returns progress.
     * Stops early on: exhausted stream, page cap, request budget, or a BLOCK.
     *
     * ONE LOOP AT A TIME. When the tool call times out, the page loop keeps
     * running (a promise cannot be cancelled; measured 2026-09-29 in the
     * in-app browser against a slow local server: after the 45 s timeout the
     * loop finished page 3 and went on to page 4). A
     * second step() started then would fetch the same page again, find no
     * new ids on it, and end the run as 'exhausted' with most pages unread.
     * So a second call returns at once with an error; poll status() until
     * `running` is false, then call step() again.
     */
    async step(n) {
      const s = this.st;
      if (!s) return { err: 'call start() first' };
      if (s.running) {
        return Object.assign(this.status(), {
          err: 'step() is already running (an earlier call timed out but its loop goes on). ' +
               'Wait with computer{action:"wait"}, poll status() until running is false, then call step() again.',
        });
      }
      s.running = true;
      try {
        for (let k = 0; k < (n || 1) && !s.stop; k++) {
          // LAST_PAGE as well: a state restored or carried over from older
          // code can hold a maxPages above it.
          if (s.page >= s.maxPages || s.page >= LAST_PAGE) { s.stop = 'page-cap'; break; }
          if (s.requests >= s.maxRequests) { s.stop = 'request-budget'; break; }
          const p = s.page + 1;
          let html = '', finalUrl = '', status = null;
          s.requests++;
          try {
            const r = await fetch(s.base + '&page=' + p, { credentials: 'include' });
            finalUrl = r.url;
            status = typeof r.status === 'number' ? r.status : null;
            html = await r.text();
          } catch (e) {
            s.lastErr = noQ('fetch:' + String(e).slice(0, 100));
            s.stop = 'fetch-error';
            break;
          }
          // Checked BEFORE the parse is trusted. A LOUD wall must never be
          // reported as a parse bug, and a QUIET one must never be reported as
          // "the page had no data" — see wallVerdict above. The second check
          // runs only when nothing parsed, on the page's visible text, so the
          // big-HTML-no-content rule can fire at all (see pageText()).
          const c = carve(html);
          /* A page whose payload parsed served content. Its text counts only
           * for the wall's own sentences, as in listing.js: one title with
           * "please slide" in the payload made a served page 'blocked'
           * (recheck, 2026-10-18). The URL and the captcha HTML always count. */
          const wallText = c.err ? html : (STRONG_WALL.test(pageText(html)) ? pageText(html) : '');
          let verdict = wallVerdict({
            url: finalUrl, text: wallText, html: html, dataNodes: c.err ? 0 : 1,
          });
          // Only when the anchor itself is missing. A json or unbalanced error
          // means the payload DID come back (rule 1), so it stays a
          // parse-error with its cause in lastErr.
          if (verdict.state === 'clear' && c.err === 'no-anchor') {
            const quiet = wallVerdict({ url: finalUrl, text: pageText(html), html: html, dataNodes: 0 });
            if (quiet.state !== 'clear') verdict = quiet;
          }
          if (verdict.state !== 'clear') {
            s.stop = verdict.state === 'blocked' ? 'blocked' : 'suspect-wall';
            s.wall = verdict;
            break;
          }
          /* A 429, 503 or 404, or a redirect off the storefront (a login
           * page), is not a parse bug: it used to read "parse-error /
           * no-anchor" with the status lost (review, 2026-10-18). It is a
           * fetch-error naming the status; resume() retries the page. */
          if (status != null && (status < 200 || status >= 300)) {
            s.lastErr = 'http ' + status + ' on page ' + p; s.stop = 'fetch-error'; break;
          }
          // A page that did not parse and came from ANOTHER host (a sign-in
          // page, say) is named by where it went, path only.
          if (c.err) {
            let host = '', want = '', path = '';
            try { const u = new URL(finalUrl); host = u.host; path = u.pathname; } catch (e) { host = ''; }
            try { want = new URL(s.base).host; } catch (e) { want = ''; }
            if (host && want && host !== want) {
              s.lastErr = 'redirected to ' + host + path; s.stop = 'fetch-error'; break;
            }
          }
          if (c.err) { s.lastErr = noQ(c.err); s.stop = 'parse-error'; break; }
          /* A page with the anchor but another shape used to throw a
           * TypeError here, out of step(), with no stop and no pages[]
           * entry; the next step() went on to page p+1 and page p was lost
           * without a word. The page is counted only once it has parsed. */
          const f = c.obj && c.obj.data && c.obj.data.root && c.obj.data.root.fields;
          if (!f || typeof f !== 'object') {
            s.lastErr = 'shape:no data.root.fields on page ' + p;
            s.stop = 'parse-error';
            break;
          }
          const info = f.pageInfo || {};
          const arr = Array.isArray(f.mods && f.mods.itemList && f.mods.itemList.content)
            ? f.mods.itemList.content : [];
          // `finished` is recorded for diagnosis only. It is NOT a stop signal:
          // see the stop rules below the item loop.
          const fin = info.finished === true;
          /* The page is built first and committed only once all of it has
           * been read. A throw half way (an item field of an unexpected
           * type) used to leave page p counted as read with part of its
           * items, so resume() went on to p+1 and the rest of p was lost
           * (review of the fix, 2026-10-18). Field reads are type-safe too. */
          const str = (v) => (v == null ? '' : String(v));
          const batch = [];
          const batchIds = new Set();
          let noId = 0;
          for (const it of arr) {
            const id = str(it && it.productId);
            if (!id) { noId++; continue; }
            if (s.seen.has(id) || batchIds.has(id)) continue;
            batchIds.add(id);
            const prices = it.prices || {};
            const sale = prices.salePrice || {};
            const orig = prices.originalPrice || {};
            const desc = clean(str(it.trade && it.trade.tradeDesc));
            const m = desc.match(SOLD_RE);
            const soldRaw = m ? m[1].replace(/\s/g, '') : null;
            batch.push(mk({
              id,
              title: clean(str(it.title && it.title.displayTitle)),
              price: typeof sale.minPrice === 'number' ? sale.minPrice : null,
              currency: typeof sale.currencyCode === 'string' ? sale.currencyCode : null,
              wasPrice: typeof orig.minPrice === 'number' ? orig.minPrice : null,
              discountPct: typeof sale.discount === 'number' ? sale.discount : null,
              rating: it.evaluation && typeof it.evaluation.starRating === 'number'
                ? it.evaluation.starRating : null,
              soldRaw,
              soldText: desc && parseSold(soldRaw) === null ? desc.slice(0, 80) : null,
              image: (() => {
                const im = it.image || {};
                const u = str(im.imgUrl || im.imgUrlOrigin);
                return u ? (u.startsWith('//') ? 'https:' + u : u) : null;
              })(),
              page: p,
            }));
          }
          const rel = arr.length
            ? queryRelevance(s.query, arr.map((it) => clean(str(it && it.title && it.title.displayTitle))))
            : { measured: false };
          // ---- commit page p ----
          s.page = p;
          if (s.claimedTotal === null && info.totalResults != null) {
            s.claimedTotal = info.totalResults;
          }
          if (!arr.length) {
            s.pages.push({ page: p, n: 0, fresh: 0, finished: fin });
            s.stop = 'exhausted'; s.endSignal = 'empty-page'; break;
          }
          /* Rows with no readable id are not "already seen". A page whose
           * rows mostly lack productId (the site renamed the field) used to
           * end the run as exhausted / no-new-ids, 0 items, "all results"
           * (review, 2026-10-18). It is a parse-error, and the page is not
           * counted. */
          if (noId * 2 >= arr.length) {
            s.page = p - 1;
            s.lastErr = 'shape:' + noId + ' of ' + arr.length + ' rows on page ' + p + ' have no productId';
            s.stop = 'parse-error';
            break;
          }
          const fresh = batch.length;
          batch.forEach((i) => { s.seen.add(i.id); s.items.push(i); });
          s.pages.push(Object.assign({ page: p, n: arr.length, fresh, finished: fin,
                         onQuery: rel.measured ? rel.share : null }, noId ? { noId } : {}));
          // Saved per page: a later page may hang the tab for good.
          s.backup = persist(s);
          /* STOP RULES (measured 2026-09-29, signed-in Chrome, USD account).
           * The stream is dry only when a page comes back EMPTY, or when every
           * id on it was already seen (the server is repeating itself).
           *
           * `pageInfo.finished` used to end the run. It is not trustworthy:
           * "cheese grater" reported finished:true on pages 1, 2 AND 3, and page
           * 3 still held 60 ids never seen before; the stream really ended at
           * page 5 (60, 60, 60, 50, then 0). The harvester stopped after page 1
           * and would have called 60 of 230 items "exhausted-all-results".
           * A short page is not an end either: "vegetable slicer" served 48 on
           * page 4 and then 1 more item on page 5, before an empty page 6.
           * Reading to the empty page costs one extra request per harvest.
           * totalResults was no better: it grew with each page read (60, 120,
           * 180), so it counts what was served, not what exists. */
          if (fresh === 0) { s.stop = 'exhausted'; s.endSignal = 'no-new-ids'; break; }
        }
      } catch (e) {
        // Never a silent skip: an unexpected shape stops the run, named.
        s.lastErr = noQ('step:' + String(e).slice(0, 100));
        s.stop = s.stop || 'parse-error';
      } finally {
        s.running = false;
        s.backup = persist(s);
      }
      return this.status();
    },

    status() {
      const s = this.st;
      if (!s) return { err: 'not started' };
      const rel = queryRelevance(s.query, s.items.map((i) => i.title));
      return {
        query: s.query, startPage: s.startPage || 1, pagesRead: s.page, requests: s.requests,
        maxRequests: s.maxRequests,
        unique: s.seen.size, stop: s.stop, endSignal: s.endSignal, lastErr: s.lastErr == null ? null : noQ(s.lastErr),
        blocked: s.stop === 'blocked',
        suspectedWall: s.stop === 'suspect-wall',
        wall: s.wall || null,
        claimedTotal: s.claimedTotal,
        // Short on purpose: the Chrome connector cuts a result at 1,000
        // characters. payload().relevance has the sample titles.
        relevance: rel.measured ? { share: rel.share, checked: rel.checked, offQuery: !!rel.warning }
                                : { measured: false, reason: rel.reason },
        backup: s.backup ? (s.backup.ok ? { saved: true, items: s.backup.items } : { saved: false, err: s.backup.err }) : null,
        done: s.stop !== null,
        running: !!s.running,
        visibility: visibility(),
      };
    },

    /* JSON string ready to pipe into rank.mjs. `coverage` is deliberately
     * NOT a percentage of claimedTotal — that number is unreliable. What is
     * true and useful is whether the stream was exhausted or cut short, and
     * whether it was the product at all (`relevance`): an off-query stream
     * gets verdict 'off-query' however dry it ran (see queryRelevance). */
    payload() {
      const s = this.st;
      if (!s) return JSON.stringify({ err: 'not started' });
      const rel = queryRelevance(s.query, s.items.map((i) => i.title));
      const startPage = s.startPage || 1;
      const stream = s.stop === 'exhausted'
        ? (startPage === 1 ? 'exhausted-all-results' : 'exhausted-from-start-page')
        : 'truncated';
      return JSON.stringify({
        query: s.query,
        // Path only. The full URL carries a query string, which makes the
        // Chrome connector block the whole result — see start().
        searchPath: '/w/wholesale-' + s.slug + '.html',
        sort: 'total_tranpro_desc',
        extraApplied: !!s.extra,
        source: 'harvest-paged',
        blocked: s.stop === 'blocked',
        suspectedWall: s.stop === 'suspect-wall',
        wall: s.wall || null,
        fourStar: s.fourStar,
        // Names the extra filters without echoing them (the Chrome
        // connector blocks a result holding a query string). Two runs are
        // the same search stream only when query, fourStar and filterKey
        // match; decode.mjs merges page numbers only within one stream.
        filterKey: filterKey(s),
        coverage: {
          verdict: rel.warning ? 'off-query' : stream,
          streamVerdict: stream,
          stop: s.stop,
          endSignal: s.endSignal,
          startPage,
          pagesRead: s.page,
          requests: s.requests,
          claimedTotal: s.claimedTotal,
          claimedTotalIsUnreliable: true,
        },
        relevance: rel,
        warnings: rel.warning ? [rel.warning] : [],
        pages: s.pages,
        cardCount: s.items.length,
        withRating: s.items.filter((i) => i.rating !== null).length,
        items: s.items,
      }, null, 0);
    },
  };

  /* Installing again (re-pasting this file) must not orphan a running loop
   * or throw away a harvest: the old loop would keep fetching beside a new
   * one, uncounted. A running install is left in place; an idle one hands
   * its state to the new code. */
  const prev = window.__aeHarvest;
  if (prev && prev.st && prev.st.running) {
    return 'aeHarvest already installed and its step() loop is still running: NOT replaced. ' +
           'Poll __aeHarvest.status() until running is false, then install again.';
  }
  if (prev && prev.st) {
    H.st = prev.st;
    // A state from an older install lacks newer fields: a start time (its
    // backup key would sort as the oldest, stamp 0) and a start page.
    if (!H.st.startedAt) H.st.startedAt = Date.now();
    if (!H.st.startPage) H.st.startPage = 1;
    H.st.backup = persist(H.st);
  }
  window.__aeHarvest = H;
  /* The export named here is the one SKILL.md step 3 gives: a plain
   * send(8765) was refused by both browsers on 2026-10-18, so naming it
   * cost one wasted call per export (review, 2026-10-18). */
  return 'aeHarvest ready' + (H.st ? ' (kept the current harvest: ' + H.st.items.length + ' items; start() begins a new one)' : '') +
         '. __aeHarvest.start({query:"..."}) then await __aeHarvest.step(6) until done (top-level await). ' +
         'To export, check the receiver (curl -s http://127.0.0.1:8765/ answers ok), then ' +
         'await __aeHarvest.send(8765, {via:\'form\'}) (a plain send() was refused by both browsers on 2026-10-18). ' +
         '__aeHarvest.restore() reloads a saved harvest';
})()
