#!/usr/bin/env node
/* Which listings are the same product? Compares the photos labels.sh fetched.
 *
 *   labels.sh fetch <out>/<listing id> <gallery url...>          # once per listing
 *   labels.sh fetch --desc <out>/<listing id> <description url...>
 *   labels.sh same <out>/*                         # or: node same.mjs <dir> <dir> ...
 *   node same.mjs --json <dir> <dir> ...
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
 * Each directory is one listing, named by its last path part (the listing
 * id, when labels.sh fetch wrote into <out>/<id>). An argument that is not a
 * directory, or a directory with no img<N>.png, is skipped and named: one bad
 * entry in <out>/* used to stop the whole comparison. Put a group's first
 * name on every member as "product" in finalists.json; rank.mjs then ranks
 * the product once and names the other listings with their prices.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const IMG = /^img\d+\.png$/;

/** listings: [{ name, hashes: [...] }]. Returns { pairs, groups, chains }:
 * every pair that shares a photo, the same-product groups (every pair in a
 * group is the same product), and the chains (joined only through a middle
 * listing), both in input order. */
export function photoGroups(listings) {
  const sets = listings.map((l) => ({ name: l.name, set: new Set(l.hashes) }));
  const pairs = [];
  const same = new Set();
  for (let a = 0; a < sets.length; a++) {
    for (let b = a + 1; b < sets.length; b++) {
      let shared = 0;
      for (const h of sets[a].set) if (sets[b].set.has(h)) shared++;
      if (!shared) continue;
      const smaller = Math.min(sets[a].set.size, sets[b].set.size);
      const isSame = shared >= Math.max(2, Math.ceil(smaller / 2));
      pairs.push({ a: sets[a].name, b: sets[b].name, shared, photosA: sets[a].set.size, photosB: sets[b].set.size, same: isSame });
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
  const json = args.includes('--json');
  const dirs = args.filter((a) => a !== '--json');
  const die = (m) => { console.error('same: ' + m); process.exit(2); };
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
    listings.push({ name, hashes: files.map((f) => createHash('md5').update(readFileSync(join(d, f))).digest('hex')) });
  }
  if (listings.length < 2) {
    die('fewer than 2 listing directories with gallery photos (' + listings.length + ')' +
      (skipped.length ? '; skipped: ' + skipped.map((s) => s.name + ' (' + s.why + ')').join(', ') : ''));
  }
  const res = photoGroups(listings);
  if (json) console.log(JSON.stringify({ ...res, skipped }));
  else {
    for (const s of skipped) console.log('skipped: ' + s.name + ': ' + s.why);
    for (const g of res.groups) {
      console.log('same product: ' + g.join(' ') + '   -> "product": "' + g[0] + '" on each');
      for (const p of res.pairs.filter((x) => x.same && g.includes(x.a))) {
        console.log('  ' + p.a + ' = ' + p.b + ': ' + p.shared + ' shared (of ' + p.photosA + ' and ' + p.photosB + ' distinct photos)');
      }
    }
    for (const c of res.chains) {
      const links = res.pairs.filter((x) => x.same && c.includes(x.a));
      console.log('NOT one product: ' + c.join(' ') + ': only ' + links.map((p) => p.a + ' = ' + p.b).join(', ') +
        ' are the same product; a listing in the middle may show both. Compare by eye, and set no product key.');
    }
    for (const p of res.pairs.filter((x) => !x.same)) {
      console.log('some photos in common: ' + p.a + ' ' + p.b + ': ' + p.shared + ' shared (of ' + p.photosA + ' and ' +
        p.photosB + '). Not enough to call them one product: compare by eye.');
    }
    if (!res.pairs.length) console.log('no photo in common: ' + listings.length + ' listings, ' + listings.length + ' products');
  }
}
