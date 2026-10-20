/* Pure helpers shared by rank.mjs and the test suite.
 *
 * extract.js, harvest.js and listing.js run inside the browser and CANNOT
 * import this file, so they inline copies of the helpers they need
 * (parseSold, SOLD_RE, parseReviewBlock, wallVerdict) between @shared
 * markers, and so does the step-5 snippet in SKILL.md. test.mjs pulls
 * every copy out and
 * asserts it agrees with this one on every fixture, so they cannot silently
 * drift apart.
 */

export const BIDI_RE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Strip RTL bidi control marks and collapse whitespace. */
export function clean(s) {
  return (s || '').replace(BIDI_RE, '').replace(/\s+/g, ' ').trim();
}

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
 * page, "10,000+ sold" on an English one. From 100,000 up the number carries
 * a K ("100K+ sold", measured 2026-09-25). Without [KkMm] the match failed
 * and soldRaw came back null for the best sellers of the pool. */
const SOLD_RE = /([\d.,]+\s*[KkMm]?\s*\+?)\s*(?:נמכר|sold)/i;
/* @shared:soldRe:end */

/* @shared:reviewBlock:start */
/* Read a detail page's review counts from its rendered text.
 *
 * WHY (measured 2026-09-25, 17 listings in two searches): the JSON-LD
 * reviewCount, the header "N Reviews" and the "Reviews (N)" tab are one and
 * the same number, and on most listings it is POOLED across similar items
 * from other sellers. The page says so: "Reviews displayed are from various
 * sellers for similar items on AliExpress". The review block carries a
 * second, smaller figure, "4.9 1090 ratings", which is the listing's own
 * count. Header vs own: 5,479 vs 1,090; 9,460 vs 1,914; 4,779 vs 488. On
 * the one listing without that note the two were equal (37 vs 37). Ranking
 * on the header ranked the pool, not the listing. "own" is inferred from the
 * page; no AliExpress documentation was found.
 *
 * own is null when the block is not found (the Hebrew wording has not been
 * observed). Null means UNKNOWN: never fall back to the pooled number.
 */
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

export { parseSold, SOLD_RE, parseReviewBlock, wallVerdict, queryRelevance };

/** Median of a numeric array, or null when empty. */
export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
