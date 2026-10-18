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
 * a whole word or a simple inflection of it (see `stemWord`: plurals,
 * -er/-ing/-ed, mice/mouse; "wire" is not "wired"). The craft wire holds
 * none of "wired", "usb", "mouse", so the live case is caught.
 *
 * WHY SO LOOSE (review of the fix, 2026-10-18): a stricter "head word"
 * rule needs to know which keyword is the noun. Taking the last word failed
 * on "mouse wired" and "mouse for computer"; a list of qualifier words
 * failed on "rc car", "coil spring" and "faux leather", whose last word is
 * the noun but was on the list. A false alarm makes the operator throw a
 * good harvest away, so the check must never fire on a correct stream. The
 * cost: an off stream that shares one keyword passes (craft wire for
 * "wire brush set"). `keywordShare` gives the share per keyword, so a low
 * share on the noun can still be seen by eye.
 *
 * A title holding a Hebrew, Arabic or Cyrillic word cannot be compared with
 * English keywords: on the Hebrew storefront "כבל USB Type C Samsung" is a
 * cable whose noun is Hebrew. Such titles are not counted; when they are
 * half or more, the stream is unmeasured, never off-query.
 */
function queryRelevance(query, titles) {
  var STOP = /^(and|for|the|with|set|sets|pcs|pc|new|of|in|on|to|a|an|kit|lot)$/;
  var words = function (s) { return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); };
  // Each keyword once: "usb c to usb c cable" counted usb twice.
  var toks = words(query).filter(function (t, i, a) { return t.length >= 2 && !STOP.test(t) && a.indexOf(t) === i; });
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
   * English keywords either. Their function words give them away. */
  var FOREIGN = /(^|[^a-z])(para|con|und|mit|für|pour|avec|sans|sin|por|les|des|une|della|voor|och)([^a-z]|$)/i;
  var foreign = latin.filter(function (t) { return FOREIGN.test(t); }).length;
  if (foreign * 10 >= latin.length * 3) {
    return { measured: false, reason: 'titles-not-english', checked: 0, keywords: toks };
  }
  /* One word for its simple forms: plurals (boxes, cables, knives, mice),
   * -er/-ing/-ed (charger, charging), -ier/-ying (magnifier, magnifying).
   * A base must keep 4+ letters, so "wired" stays "wired", never "wire".
   * A shared PREFIX is not a shared word: "water" and "waterproof",
   * "table" and "tablet" used to match (review, 2026-10-18). */
  var IRREGULAR = { mice: 'mouse', men: 'man', women: 'woman', feet: 'foot', teeth: 'tooth', children: 'child', geese: 'goose' };
  var stemWord = function (w) {
    if (IRREGULAR[w]) return IRREGULAR[w];
    if (w.length > 5 && /ives$/.test(w)) return w.slice(0, -4) + 'ife';
    if (w.length > 5 && /ves$/.test(w)) return w.slice(0, -3) + 'f';
    if (w.length > 4 && /ies$/.test(w)) return w.slice(0, -3) + 'y';
    if (w.length > 5 && /ying$/.test(w)) return w.slice(0, -4) + 'y';
    if (/(s|x|z|ch|sh)es$/.test(w) && w.length > 5) return w.slice(0, -2);
    var m = w.match(/^(.{4,}?)(ings|ing|ers|er|ed|s)$/);
    var b = m ? m[1] : w;
    return b.replace(/i$/, 'y');
  };
  var has = function (ws, t) {
    var st = stemWord(t);
    return ws.some(function (w) { return w === t || stemWord(w) === st; });
  };
  var per = {};
  toks.forEach(function (k) { per[k] = 0; });
  var on = 0;
  var off = [];
  latin.forEach(function (t) {
    var ws = words(t);
    var hit = false;
    toks.forEach(function (k) { if (has(ws, k)) { per[k]++; hit = true; } });
    if (hit) on++;
    else if (off.length < 3) off.push(t.slice(0, 60));
  });
  var r3 = function (x) { return Math.round(x * 1000) / 1000; };
  var keywordShare = {};
  toks.forEach(function (k) { keywordShare[k] = r3(per[k] / latin.length); });
  var share = on / latin.length;
  var warn = latin.length >= 5 && share < 0.5;
  return {
    measured: true, keywords: toks, keywordShare: keywordShare,
    checked: latin.length, onQuery: on, share: r3(share),
    offSample: off,
    warning: warn
      ? 'off-query-results: only ' + on + ' of ' + latin.length + ' titles hold any of the keywords [' +
        toks.join(', ') + ']. The site served another category (e.g. ' + JSON.stringify(off[0] || '') +
        '). This is NOT a complete harvest of the product: do not report it as exhausted-all-results. ' +
        'Re-word the query and say so to the user.'
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
