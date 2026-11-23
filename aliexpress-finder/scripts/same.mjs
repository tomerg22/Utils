#!/usr/bin/env node
/* Which listings are the same product? Compares the photos labels.sh fetched.
 *
 *   labels.sh fetch <out>/<listing id> <gallery url...>          # once per listing
 *   labels.sh fetch --desc <out>/<listing id> <description url...>
 *   labels.sh same <out>/*                         # or: node same.mjs <dir> <dir> ...
 *   node same.mjs --json <dir> <dir> ...
 *   node same.mjs --near 0 <dir> <dir> ...         # byte-identical photos only
 *
 * WHY (measured 2026-11-08, the Dell charger session): three Reletech
 * listings had byte-identical photos (8 of 8, and 19 of 19 distinct) and took
 * rows 1-3 of a top-4 table; XZT and BOJECHER were listed twice each. Their
 * image URLs differed (each seller uploads its own copy), so only the bytes
 * tell. An md5 check by hand found it; nothing in the skill did.
 *
 * ONLY GALLERY PHOTOS COUNT (img<N>.png). Description images (desc<N>.png,
 * fetched with --desc) are left out: a store puts the same banners in the
 * descriptions of different products, and with them two products that share
 * no photo of their own were one group (review of 58c8a00). Crops and
 * contact sheets are left out too.
 *
 * Two listings are the SAME PRODUCT when they share at least half of the
 * smaller one's distinct photos, and at least 2. A pair with fewer shared
 * photos is reported as "some photos in common": look at it by eye.
 *
 * A GROUP is a set of listings in which EVERY pair is the same product. A
 * chain (A = B and B = C, but A and C share no photo; B may show both
 * products) is reported as a chain and given no product key: it used to be
 * one group, so a 100W charger was ranked as "also listed as" a 65W one
 * (review of 58c8a00).
 *
 * NEAR COPIES COUNT TOO (added 2026-11-23, the wired-mouse session). Two
 * listings of one plain office mouse (1005011653811679, 1005007439751313)
 * showed the same banners and the same 110 x 55 x 33 mm drawing, but each
 * seller had re-encoded the files, so no md5 matched and this file said
 * nothing; they were grouped by eye. Each photo now also gets a 256-bit
 * difference hash (sips scales it to 17 x 16 grey pixels, and each bit says
 * whether a pixel is darker than its right neighbour). Two photos are near
 * copies at --near bits apart or fewer (default 8). Measured on that run's
 * 266 gallery photos of 20 listings: the re-encoded copies were 1 to 16 bits
 * apart, photos of different mice 19 or more, and the 64-bit form was too
 * coarse (a Logitech G502 came 2 bits from a plain office mouse). The one
 * pair under 8 that is not a copy was 5 bits: two brands' photos of one
 * generic shell (X1 and Limei S1); one shared photo is never enough for a
 * group. Without sips (not macOS) only byte-identical photos count, and the
 * output says so.
 *
 * Each directory is one listing, named by its last path part (the listing
 * id, when labels.sh fetch wrote into <out>/<id>). An argument that is not a
 * directory, or a directory with no img<N>.png, is skipped and named: one bad
 * entry in <out>/* used to stop the whole comparison. Put a group's first
 * name on every member as "product" in finalists.json; rank.mjs then ranks
 * the product once and names the other listings with their prices.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const IMG = /^img\d+\.png$/;
export const NEAR_BITS = 8;
const DH_W = 17, DH_H = 16; // 16 x 16 = 256 bits

/** The 256-bit difference hash of a DH_W x DH_H BMP (24 or 32 bits a pixel,
 * as sips writes it), as 64 hex digits; null when the file is not one. */
export function dhashFromBmp(buf) {
  if (!buf || buf.length < 54 || buf.toString('latin1', 0, 2) !== 'BM') return null;
  const off = buf.readUInt32LE(10), w = buf.readInt32LE(18), h = buf.readInt32LE(22), bpp = buf.readUInt16LE(28);
  const H = Math.abs(h);
  if ((bpp !== 24 && bpp !== 32) || w < 2 || !H) return null;
  const row = Math.ceil((w * bpp) / 32) * 4;
  if (off + row * H > buf.length) return null;
  let bits = '';
  for (let y = 0; y < H; y++) {
    const yy = h > 0 ? H - 1 - y : y; // a positive height is stored bottom-up
    const grey = [];
    for (let x = 0; x < w; x++) {
      const o = off + yy * row + x * (bpp / 8);
      grey.push(0.299 * buf[o + 2] + 0.587 * buf[o + 1] + 0.114 * buf[o]);
    }
    for (let x = 0; x + 1 < w; x++) bits += grey[x] < grey[x + 1] ? '1' : '0';
  }
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4).padEnd(4, '0'), 2).toString(16);
  return hex;
}
/** Set bits in a hex hash. */
export function popcount(h) {
  let n = 0;
  for (const c of String(h)) { let x = parseInt(c, 16); while (x) { n += x & 1; x >>= 1; } }
  return n;
}
/* A flat image (one colour, a blank tile) has every bit 0, so any two flat
 * images were near copies: a suite test of solid-colour photos made two
 * products one. Measured 2026-11-23 on 180 real gallery photos: the fewest
 * set bits was 23 of 256 and the most 204. A hash with under 12 set or under
 * 12 unset bits (half the lowest seen) is too flat: such a photo matches by
 * its bytes only. */
export const MIN_TEXTURE = 12;
export const textured = (h) => { const n = popcount(h); return n >= MIN_TEXTURE && n <= h.length * 4 - MIN_TEXTURE; };
/** Bits that differ between two hex hashes of one length. */
export function hamming(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { n += x & 1; x >>= 1; }
  }
  return n;
}

/** listings: [{ name, hashes: [...] }], each hash an md5 string or
 * { md5, dh }. opts.near: the most bits apart for a near copy (0: only
 * byte-identical photos). Returns { pairs, groups, chains }: every pair that
 * shares a photo, the same-product groups (every pair in a group is the same
 * product), and the chains (joined only through a middle listing), both in
 * input order. A pair's `near` counts the shared photos that matched only as
 * near copies. */
export function photoGroups(listings, opts = {}) {
  const near = opts.near == null ? NEAR_BITS : opts.near;
  const photo = (h) => (typeof h === 'string' ? { md5: h, dh: null } : { md5: h.md5, dh: h.dh && textured(h.dh) ? h.dh : null });
  const match = (p, q) => (p.md5 === q.md5 ? 'exact'
    : near > 0 && p.dh && q.dh && p.dh.length === q.dh.length && hamming(p.dh, q.dh) <= near ? 'near' : null);
  // A listing's distinct photos: a near copy of one already kept is the same photo.
  const sets = listings.map((l) => {
    const kept = [];
    for (const h of l.hashes) { const p = photo(h); if (!kept.some((k) => match(k, p))) kept.push(p); }
    return { name: l.name, set: kept };
  });
  const matched = (from, to) => {
    let n = 0, nearOnly = 0;
    for (const p of from) {
      const kinds = to.map((q) => match(p, q)).filter(Boolean);
      if (!kinds.length) continue;
      n++;
      if (!kinds.includes('exact')) nearOnly++;
    }
    return { n, nearOnly };
  };
  const pairs = [];
  const same = new Set();
  for (let a = 0; a < sets.length; a++) {
    for (let b = a + 1; b < sets.length; b++) {
      const ab = matched(sets[a].set, sets[b].set), ba = matched(sets[b].set, sets[a].set);
      const shared = Math.min(ab.n, ba.n);
      if (!shared) continue;
      const smaller = Math.min(sets[a].set.length, sets[b].set.length);
      const isSame = shared >= Math.max(2, Math.ceil(smaller / 2));
      pairs.push({ a: sets[a].name, b: sets[b].name, shared, near: Math.min(ab.nearOnly, shared),
        photosA: sets[a].set.length, photosB: sets[b].set.length, same: isSame });
      if (isSame) same.add(sets[a].name + '\n' + sets[b].name);
    }
  }
  const isSamePair = (x, y) => same.has(x + '\n' + y) || same.has(y + '\n' + x);
  // Connected parts first, then each one is a group only when every pair in it is the same product.
  const parent = new Map(sets.map((s) => [s.name, s.name]));
  const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
  for (const p of pairs) {
    if (!p.same) continue;
    const ra = find(p.a), rb = find(p.b);
    if (ra !== rb) parent.set(rb, ra);
  }
  const byRoot = new Map();
  for (const s of sets) {
    const r = find(s.name);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(s.name);
  }
  const groups = [], chains = [];
  for (const part of byRoot.values()) {
    if (part.length < 2) continue;
    const every = part.every((x, i) => part.slice(i + 1).every((y) => isSamePair(x, y)));
    (every ? groups : chains).push(part);
  }
  return { pairs, groups, chains };
}

const isMain = process.argv[1] && /same\.mjs$/.test(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const die = (m) => { console.error('same: ' + m); process.exit(2); };
  const json = args.includes('--json');
  let near = NEAR_BITS;
  const ni = args.indexOf('--near');
  if (ni >= 0) {
    near = Number(args[ni + 1]);
    if (!/^\d+$/.test(String(args[ni + 1] || '')) || near > 64) die('--near needs a whole number of bits, 0 to 64 (0: byte-identical photos only)');
  }
  const dirs = args.filter((a, i) => a !== '--json' && a !== '--near' && !(ni >= 0 && i === ni + 1));
  /* The difference hashes of a listing's photos, one sips call per listing;
   * null for each when sips is missing or fails. */
  let haveSips = true;
  try { execFileSync('sips', ['--help'], { stdio: 'ignore' }); } catch (e) { haveSips = false; }
  const tmpRoot = near > 0 && haveSips ? mkdtempSync(join(tmpdir(), 'aef-same-')) : null;
  const dhashes = (d, files) => {
    if (!tmpRoot) return files.map(() => null);
    const out = mkdtempSync(join(tmpRoot, 'l-'));
    try {
      execFileSync('sips', ['-s', 'format', 'bmp', '-z', String(DH_H), String(DH_W), ...files.map((f) => join(d, f)), '--out', out + '/'], { stdio: 'ignore' });
    } catch (e) { /* the files it could convert are there */ }
    return files.map((f) => { try { return dhashFromBmp(readFileSync(join(out, f.replace(/\.png$/, '.bmp')))); } catch (e) { return null; } });
  };
  const listings = [];
  const skipped = [];
  for (const d of dirs) {
    const name = basename(d.replace(/\/+$/, ''));
    let files;
    try {
      if (!statSync(d).isDirectory()) { skipped.push({ name: d, why: 'not a directory' }); continue; }
      files = readdirSync(d).filter((f) => IMG.test(f));
    } catch (e) { skipped.push({ name: d, why: String(e.message).slice(0, 80) }); continue; }
    if (!files.length) { skipped.push({ name: d, why: 'no img<N>.png in it (no gallery photo was fetched)' }); continue; }
    if (listings.some((l) => l.name === name)) die('two directories are named ' + name + ': one directory per listing id');
    const dh = dhashes(d, files);
    listings.push({ name, hashes: files.map((f, k) => ({ md5: createHash('md5').update(readFileSync(join(d, f))).digest('hex'), dh: dh[k] })) });
  }
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  if (listings.length < 2) {
    die('fewer than 2 listing directories with gallery photos (' + listings.length + ')' +
      (skipped.length ? '; skipped: ' + skipped.map((s) => s.name + ' (' + s.why + ')').join(', ') : ''));
  }
  const res = photoGroups(listings, { near });
  const how = near === 0 ? 'byte-identical photos only (--near 0)'
    : !haveSips ? 'byte-identical photos only: sips was not found, so near copies were not compared'
    : 'byte-identical photos and near copies (' + near + ' of 256 bits or fewer apart)';
  const sharedText = (p) => p.shared + ' shared (of ' + p.photosA + ' and ' + p.photosB + ' distinct photos' +
    (p.near ? '; ' + p.near + ' of them near copies, not byte-identical' : '') + ')';
  if (json) console.log(JSON.stringify({ ...res, skipped, near: tmpRoot ? near : 0, compared: how }));
  else {
    console.log('compared: ' + how);
    for (const s of skipped) console.log('skipped: ' + s.name + ': ' + s.why);
    for (const g of res.groups) {
      console.log('same product: ' + g.join(' ') + '   -> "product": "' + g[0] + '" on each');
      for (const p of res.pairs.filter((x) => x.same && g.includes(x.a))) {
        console.log('  ' + p.a + ' = ' + p.b + ': ' + sharedText(p));
      }
    }
    for (const c of res.chains) {
      const links = res.pairs.filter((x) => x.same && c.includes(x.a));
      console.log('NOT one product: ' + c.join(' ') + ': only ' + links.map((p) => p.a + ' = ' + p.b).join(', ') +
        ' are the same product; a listing in the middle may show both. Compare by eye, and set no product key.');
    }
    for (const p of res.pairs.filter((x) => !x.same)) {
      console.log('some photos in common: ' + p.a + ' ' + p.b + ': ' + sharedText(p) +
        '. Not enough to call them one product: compare by eye.');
    }
    if (!res.pairs.length) console.log('no photo in common: ' + listings.length + ' listings, ' + listings.length + ' products');
  }
}
