#!/usr/bin/env node
/* Checks on saved detail records (the details-<stamp>.json that
 * __aeListing.sendAll() posts to receiver.mjs). Added 2026-11-23, the
 * wired-mouse session, for four gaps that run found:
 *
 *   node checks.mjs details-<stamp>.json                  # a report per listing
 *   node checks.mjs --json details-<stamp>.json           # the same, as JSON
 *   node checks.mjs --out checked.json details-<stamp>.json
 *       # the records with productWeightG, weightLines, connection,
 *       # optionsDiffer and checkWarnings added: the input for rank.mjs
 *
 * WHY HERE AND NOT IN listing.js: the paste copy of listing.js must stay
 * under 45,000 characters (one Read call), and it had 346 to spare. A
 * capture() record already holds what these checks read: the title, the
 * options, the selected ones, the spec rows, the size lines and the
 * description text.
 *
 * 1. specs-vs-option, button and DPI counts. KEBIDUMEI 1005006982650767
 *    opened on its option "7 Buttons 2400dpi" ($5.81), whose photos show
 *    another mouse body (a T-Wolf "FOR THE GAME" shell), while the table said
 *    "Number of Buttons: 6" and "DPI: 6400", the rows of "6 Buttons 7200dpi".
 *    listing.js compares V, W, A, RPM, mAh and sensor codes only.
 * 2. specs-vs-option, model codes. Inphic 1005009916191936: the selected
 *    option "B2 White", the row "inphic Model: B1", the model of the options
 *    "B1 White" and "B1 Black".
 * 3. options-differ. Two options that name different models or counts are
 *    different products, and the listing's own rating and count are pooled
 *    over both: the X1 listing 1005006727693525 sold a 3-key and a 7-button
 *    mouse under one 414-rating count. rank.mjs flags such an item
 *    rating-shared-by-options. The X1 case itself names no model in its
 *    options ("X1 Wired Mouse", "Only Mouse"), so only its photos tell.
 * 4. wired-vs-wireless. The vertical mouse 1005006743691875 was titled
 *    "Wired" and its table said "Type: 2.4Ghz Wireless", "Battery Included:
 *    Yes", "Power Source: Rechargeable", while all 17 photos showed a cable.
 *    Both Logitech G502 listings said "Type: Wired" beside "Power Type:
 *    Rechargeable". A cable in a photo does not settle it: a wireless mouse
 *    is shown with its charging cable. Such a listing's wired status is
 *    unknown until the user decides (SKILL.md step 7).
 * 5. weight. The user asked for each mouse's weight and nothing returned
 *    one. It was in the description text ("Product weight: 110 ± 5g",
 *    "Netweight: about 90g"), a spec row ("Product weight: 96g"), the site's
 *    summary line ("Weighing only 96g and measuring 127 x 70 x 44 mm") or
 *    only on a photo (F1: "Weight 135G±10G"). "Gross Weight", "Total weight",
 *    "Package weight" and the summary of the shipping data ("Weighing only
 *    0.070 kg and measuring 20 x 16 x 5 cm") are the SHIPPING weight. A row
 *    with no unit ("Gross Weight: 90") has grams: null.
 *
 * Text is read from the description, the spec rows and the size lines only.
 * The page text also holds reviews, pooled across sellers: a buyer's "it
 * weighs 90g" is not this listing's weight.
 */
import { readFileSync, writeFileSync } from 'node:fs';

// ---------------------------------------------------------------- counts
export const SPEC_COUNTS = [
  { what: 'buttons', opt: /(?<![\d.])(\d{1,2})\s*-?\s*(?:buttons?|keys?|btns?)(?![a-z])/gi,
    row: /^(?:number of\s+)?(?:buttons?|keys?)(?:\s+(?:number|count|qty))?$/i, min: 1, exact: true },
  { what: 'DPI', opt: /(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d{3,6})\s*(?:dpi|cpi)(?![a-z])/gi,
    row: /^(?:max\.?\s*)?(?:dpi|cpi)(?:\s*range)?$|resolution$/i, min: 100, exact: false },
];
export const countsIn = (text, re) => [...String(text || '').matchAll(re)].map((m) => Number(m[1].replace(/,/g, '')));
const rowNumbers = (value, min) => (String(value || '').match(/\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?/g) || [])
  .map((s) => Number(s.replace(/,/g, ''))).filter((n) => n >= min);
/** { option, row, value, what } per selected option whose button or DPI count
 * the spec row contradicts: buttons must be equal, a DPI inside the row's range. */
export function specCountConflicts(selected, rows) {
  const out = [];
  for (const option of selected || []) {
    for (const q of SPEC_COUNTS) {
      const mine = countsIn(option, q.opt);
      if (!mine.length) continue;
      for (const [row, value] of Object.entries(rows || {})) {
        if (!q.row.test(String(row).trim())) continue;
        const theirs = rowNumbers(value, q.min);
        if (!theirs.length) continue;
        const fits = q.exact ? mine.some((n) => theirs.includes(n))
          : mine.some((n) => n >= Math.min(...theirs) && n <= Math.max(...theirs));
        if (!fits) out.push({ option, row, value, what: q.what });
      }
    }
  }
  return out;
}

const WIRED_WORD = /(?<![a-z])wired(?![a-z])/i;
const WIRELESS_WORD = /wireless|bluetooth|2\.4\s*g(?:hz)?(?![a-z])|tri-?mode|dual-?mode|three-?mode/i;

// ---------------------------------------------------------------- models
/* A token of letters then digits: "B1", "G102", "X2", "PG1". `core` drops
 * letters after the digits ("G502HERO" -> G502), for a row that names the
 * family; the full token tells "G502HERO" from "G502SE". Ports and standards
 * that look like codes (USB3, WIN10, IP67) are not models. */
const MODEL_RE = /(?<![A-Za-z0-9])([A-Za-z]{1,4})-?(\d{1,4})([A-Za-z]{0,8})(?![A-Za-z0-9])/g;
const NOT_MODEL = /^(USB|WIN|WINDOWS|MAC|IOS|IP|PS|XP|DC|AC|HDMI|BT|LED|RGB|CPU|PC|USBC|TYPE|PIN|CM|MM|PCS)$/i;
export function modelsOf(text, full) {
  const out = new Set();
  for (const m of String(text || '').matchAll(MODEL_RE)) {
    if (NOT_MODEL.test(m[1])) continue;
    out.add((m[1] + m[2] + (full ? m[3] : '')).toUpperCase());
  }
  return out;
}
/** { option, row, value, why, other } when a row named for the model names a
 * model that another option names and no selected option does. why
 * 'differs': the selected option names another model; 'other-option': none. */
export function modelConflicts(selected, variants, rows) {
  const out = [];
  const sel = selected || [];
  const mine = new Set(sel.flatMap((o) => [...modelsOf(o)]));
  for (const [row, value] of Object.entries(rows || {})) {
    if (!/\bmodel\b/i.test(row) || /sensor/i.test(row)) continue;
    const theirs = [...modelsOf(value)];
    if (!theirs.length || theirs.some((c) => mine.has(c))) continue;
    const other = (variants || []).find((v) => !sel.includes(v) && theirs.some((c) => modelsOf(v).has(c)));
    if (!other) continue;
    for (const option of sel) {
      if (mine.size && !modelsOf(option).size) continue; // a colour tile beside the model tile
      out.push({ option, row, value, why: mine.size ? 'differs' : 'other-option', other });
    }
  }
  return out;
}
/** { a, b, why } for the first two options that name a different model
 * (full token) or a different button or DPI count, else null. */
export function optionsDiffer(variants) {
  const info = (variants || []).map((v) => ({ v, models: modelsOf(v, true), buttons: countsIn(v, SPEC_COUNTS[0].opt),
    dpi: countsIn(v, SPEC_COUNTS[1].opt),
    link: WIRELESS_WORD.test(v) ? 'wireless' : WIRED_WORD.test(v) ? 'wired' : null }));
  const same = (x, y) => x.size === y.size && [...x].every((c) => y.has(c));
  for (let i = 0; i < info.length; i++) {
    for (let j = i + 1; j < info.length; j++) {
      const a = info[i], b = info[j];
      if (a.models.size && b.models.size && !same(a.models, b.models)) return { a: a.v, b: b.v, why: 'model' };
      if (a.buttons.length && b.buttons.length && a.buttons[0] !== b.buttons[0]) return { a: a.v, b: b.v, why: 'buttons' };
      if (a.dpi.length && b.dpi.length && a.dpi[0] !== b.dpi[0]) return { a: a.v, b: b.v, why: 'DPI' };
      if (a.link && b.link && a.link !== b.link) return { a: a.v, b: b.v, why: 'connection (wired / wireless)' };
    }
  }
  return null;
}

// ------------------------------------------------------- wired / wireless
/** What the title and the spec rows say: { wired: [...], wireless: [...] } as
 * short "where: what" labels. A battery or "rechargeable" counts as wireless. */
export function connectionOf(title, rows) {
  const wired = [], wireless = [];
  const t = String(title || '');
  if (WIRED_WORD.test(t)) wired.push('title: wired');
  if (WIRELESS_WORD.test(t)) wireless.push('title: ' + t.match(WIRELESS_WORD)[0].toLowerCase());
  for (const [k, v] of Object.entries(rows || {})) {
    const val = String(v || '').trim();
    const label = String(k).slice(0, 30) + ': ' + val.slice(0, 30);
    if (WIRED_WORD.test(val)) wired.push(label);
    if (WIRELESS_WORD.test(val)) wireless.push(label);
    else if (/power\s*(type|source)|battery/i.test(k) && !/^no\b/i.test(val) &&
             /recharg|lithium|li-?ion|li-?po|battery|\baaa?\b|^yes\b/i.test(val)) wireless.push(label);
  }
  return { wired, wireless };
}

// ------------------------------------------------------------------ weight
const WEIGHT_RE = /(?<![a-zא-ת])(gross\s*weight|net\s*weight|netweight|total\s*weight|package\s*weight|packing\s*weight|shipping\s*weight|product\s*weight|item\s*weight|unit\s*weight|weight|weighs|weighing|משקל)(?![a-z])[^0-9\n]{0,24}?(\d+(?:[.,]\d+)?)\s*(?:(?:±|\+\/-|\+-)\s*\d+(?:\.\d+)?\s*)?(kg|kgs|g|gr|grams?|oz|lbs?|pounds?|גרם|ק"ג|קג)(?![a-z])/gi;
const UNIT_RE = /(\d+(?:[.,]\d+)?)\s*(kg|kgs|g|gr|grams?|oz|lbs?|pounds?|גרם|ק"ג|קג)(?![a-z])/i;
const SHIP_WEIGHT = /gross|total|packag|packing|shipping|carton|box/i;
// The same rule as listing.js LOGISTICS_RE: the site's summary of the shipping data.
const LOGISTICS_RE = /weigh(?:s|ing)?\s+(?:only\s+|about\s+)*\d+\.\d{3}\s*kg(?![a-z])/i;
const toGrams = (n, unit) => {
  const u = String(unit).toLowerCase();
  if (/^(kg|kgs|ק"ג|קג)$/.test(u)) return n * 1000;
  if (u === 'oz') return n * 28.35;
  if (/^(lbs?|pounds?)$/.test(u)) return n * 453.6;
  return n;
};
const numberOf = (s) => Number(/,\d{3}$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.'));
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const grams = (n, unit) => Math.round(toGrams(numberOf(n), unit) * 10) / 10;
/** [{ text, grams, isPackage, source }] from text pieces and spec rows. */
export function weightLinesOf(texts, rows) {
  const out = [];
  const add = (w) => { if (!out.some((x) => x.text === w.text)) out.push(w); };
  for (const t of texts || []) {
    for (const m of String(t || '').matchAll(WEIGHT_RE)) {
      const text = clean(m[0]);
      /* The words before it in the same sentence count too (second run of
       * 2026-11-23: "The mouse comes in a package size of 20 x 20 x 20 cm with
       * a weight of 0.084 kg" was read as an 84 g mouse). */
      const src = String(t);
      const before = src.slice(Math.max(0, m.index - 100), m.index).split(/[.!?;]\s|\n/).pop();
      add({ text, grams: grams(m[2], m[3]), isPackage: SHIP_WEIGHT.test(m[1]) || LOGISTICS_RE.test(text) ||
        /packag|packing|carton|shipping|parcel/i.test(before), source: 'text' });
    }
  }
  for (const [k, v] of Object.entries(rows || {})) {
    if (!/weight|משקל/i.test(k)) continue;
    const m = String(v).match(UNIT_RE);
    add({ text: clean(k + ': ' + v), grams: m ? grams(m[1], m[2]) : null, isPackage: SHIP_WEIGHT.test(k), source: 'spec' });
  }
  return out;
}
/** The product's own weight in grams when its lines agree within 10%:
 * { grams, disagree }. grams null with disagree null: no line gave one. */
export function productWeight(lines) {
  const vals = [...new Set((lines || []).filter((w) => !w.isPackage && w.grams != null && w.grams > 0).map((w) => w.grams))];
  if (!vals.length) return { grams: null, disagree: null };
  if (Math.max(...vals) <= 1.1 * Math.min(...vals)) return { grams: vals[0], disagree: null };
  return { grams: null, disagree: vals };
}

// ------------------------------------------------------------------ record
/** All checks on one capture() record. Returns the fields to add to it. */
export function checkRecord(rec) {
  const d = (rec && rec.detail) || {};
  const rows = rec.specs || d.specs || {};
  const selected = rec.selected || d.selectedVariants || [];
  const variants = rec.options || d.variants || [];
  const text = String(d.text || '');
  const at = text.indexOf(' [DESCRIPTION] ');
  const texts = [at >= 0 ? text.slice(at + 15) : '', ...((d.sizeLines || []).map((s) => (s && s.text) || ''))];
  const warnings = [];
  specCountConflicts(selected, rows).forEach((c) => warnings.push(`specs-vs-option: the selected option "${String(c.option).slice(0, 40)}" ` +
    `disagrees with spec row "${String(c.row).slice(0, 30)}": ${String(c.value).slice(0, 30)} (${c.what}). The table may describe ` +
    'another option: read the selected option\'s own image.'));
  modelConflicts(selected, variants, rows).forEach((c) => warnings.push(`specs-vs-option: spec row "${String(c.row).slice(0, 30)}": ` +
    `${String(c.value).slice(0, 30)} names the model of the option "${String(c.other).slice(0, 40)}"; the selected option ` +
    `"${String(c.option).slice(0, 40)}" ${c.why === 'differs' ? 'names another model' : 'names none'}. The table may describe ` +
    'that option: read the selected option\'s own image.'));
  const differ = optionsDiffer(variants);
  if (differ) {
    warnings.push(`options-differ: the options "${differ.a.slice(0, 40)}" and "${differ.b.slice(0, 40)}" differ on the ${differ.why}. ` +
      'The rating and the review count are for the whole listing, both products: say so beside them.');
  }
  const connection = connectionOf(rec.title || d.title, rows);
  /* Only a "Power Type"/"Power Source" row says rechargeable, and a "Battery
   * Included" row says no, while the type says wired. Seen on 7 listings in
   * the two runs of 2026-11-23 (both Logitech G502, the strawberry mouse, the
   * 7-button "FOR THE GAME" mouse, the E-Sports 5000 DPI mouse); every photo
   * of them showed a cable and none a battery or a receiver. It still is not
   * proof, so the status stays unknown, but the warning says what it is. */
  const powerOnly = connection.wired.length && connection.wireless.length &&
    connection.wireless.every((w) => /^power\s*(type|source)/i.test(w)) &&
    Object.entries(rows).some(([k, v]) => /battery included/i.test(k) && /^no\b/i.test(String(v).trim()));
  if (powerOnly) {
    warnings.push(`power-type-only: the listing says wired (${connection.wired.slice(0, 3).join('; ')}); only ` +
      `${connection.wireless.join('; ')} says otherwise, beside "Battery Included: no". Seen on 7 wired listings on 2026-11-23, ` +
      'likely a default value. Wired is still UNKNOWN by step 7: check the photos for a receiver, a battery door or a ' +
      'charging port, and report it to the user as a likely default.');
  } else if (connection.wired.length && connection.wireless.length) {
    warnings.push(`wired-vs-wireless: the listing says wired (${connection.wired.slice(0, 3).join('; ')}) and wireless or battery ` +
      `(${connection.wireless.slice(0, 3).join('; ')}). It may be dual-mode, or a line is wrong. A wired requirement is UNKNOWN ` +
      'here: a cable in a photo is not proof (a wireless mouse is shown with its charging cable). Ask the user.');
  }
  const weightLines = weightLinesOf(texts, rows);
  const weight = productWeight(weightLines);
  if (weight.disagree) {
    warnings.push(`weight-disagrees: the product weight lines say ${weight.disagree.map((g) => g + ' g').join(', ')}. ` +
      'Report each with its source; productWeightG is null.');
  }
  if (weight.grams == null && !weight.disagree) {
    // A fetched description may hold images only: then it has no text, and was read.
    const src = d.description && d.description.source;
    const read = /^(rendered|fetched)$/.test(String(src));
    warnings.push('weight-not-in-text: no product weight in the description text, the spec rows or the size lines' +
      (read ? '' : ' (the description was not read: ' + (src || 'unknown') + ')') + '. Read the photos before writing "not stated".');
  }
  return { productWeightG: weight.grams, weightLines, connection, optionsDiffer: differ, checkWarnings: warnings };
}

// -------------------------------------------------------------------- CLI
const isMain = process.argv[1] && /checks\.mjs$/.test(process.argv[1]);
if (isMain) {
  const die = (m) => { console.error('checks: ' + m); process.exit(2); };
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const oi = args.indexOf('--out');
  if (oi >= 0 && (!args[oi + 1] || args[oi + 1].startsWith('--'))) die('--out needs a file name');
  const outFile = oi >= 0 ? args[oi + 1] : null;
  const files = args.filter((a, i) => a !== '--json' && a !== '--out' && !(oi >= 0 && i === oi + 1));
  const bad = files.find((f) => /^-/.test(f));
  if (bad) die('unknown flag ' + bad + ' (known: --json, --out <file>)');
  if (!files.length) die('usage: node checks.mjs [--json] [--out checked.json] details-<stamp>.json [...]');
  const recs = [];
  for (const f of files) {
    let x;
    try { x = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { die(f + ': ' + String(e.message).slice(0, 120)); }
    const items = Array.isArray(x) ? x : x && Array.isArray(x.items) ? x.items : null;
    if (!items) die(f + ': no records (expected a details-<stamp>.json from __aeListing.sendAll())');
    if (!items.some((r) => r && (r.detail || r.specs))) die(f + ': these are not capture() records (no detail, no specs): checks need the detail records');
    recs.push(...items);
  }
  const checked = recs.map((r) => ({ ...r, ...checkRecord(r) }));
  if (outFile) writeFileSync(outFile, JSON.stringify({ kind: 'details', source: 'checks', items: checked }));
  if (json) {
    console.log(JSON.stringify(checked.map((r) => ({ id: r.id, title: String(r.title || '').slice(0, 80), productWeightG: r.productWeightG,
      weightLines: r.weightLines, connection: r.connection, optionsDiffer: r.optionsDiffer, checkWarnings: r.checkWarnings })), null, 1));
  } else {
    for (const r of checked) {
      console.log(r.id + '  ' + String(r.title || '').slice(0, 70));
      console.log('  weight: ' + (r.productWeightG != null ? r.productWeightG + ' g' : 'unknown') +
        (r.weightLines.length ? '   lines: ' + r.weightLines.map((w) => '"' + w.text + '"' + (w.isPackage ? ' (shipping)' : '')).join(', ') : ''));
      for (const w of r.checkWarnings) console.log('  ' + w);
    }
    if (outFile) console.log('\nwrote ' + outFile + ' (' + checked.length + ' records): pass it to rank.mjs --mode final');
  }
}
