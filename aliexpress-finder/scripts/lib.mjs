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

export const BIDI_RE = /[‎‏‪-‮⁦-⁩]/g;

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
    .replace(/[‎‏‪-‮⁦-⁩]/g, '')
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

export { parseSold, SOLD_RE, parseReviewBlock, wallVerdict };

/** Median of a numeric array, or null when empty. */
export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
