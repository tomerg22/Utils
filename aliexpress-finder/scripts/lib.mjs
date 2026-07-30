/* Pure helpers shared by rank.mjs and the test suite.
 *
 * extract.js runs inside the browser and CANNOT import this file, so it
 * inlines a copy of parseSold between @shared markers. test.mjs pulls that
 * copy out and asserts it agrees with this one on every fixture, so the two
 * cannot silently drift apart.
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

export { parseSold };

/** Median of a numeric array, or null when empty. */
export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
