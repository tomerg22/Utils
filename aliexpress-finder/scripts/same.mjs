#!/usr/bin/env node
/* Which listings are the same product? Compares the photos labels.sh fetched.
 *
 *   labels.sh fetch <out>/<listing id> <url...>    # once per listing
 *   labels.sh same <out>/*                          # or: node same.mjs <dir> <dir> ...
 *   node same.mjs --json <dir> <dir> ...
 *
 * WHY (measured 2026-11-08, the Dell charger session): three Reletech
 * listings had byte-identical photos (8 of 8, and 24 of 24) and took rows
 * 1-3 of a top-4 table; XZT and BOJECHER were listed twice each. Their image
 * URLs differed (each seller uploads its own copy), so only the bytes tell.
 * An md5 check by hand found it; nothing in the skill did.
 *
 * Two listings are the SAME PRODUCT when they share at least half of the
 * smaller one's distinct photos, and at least 2. Fewer shared photos are
 * reported as "some photos in common": sellers of different products share
 * banners ("We want your feedback", a ring of protection icons), so one or
 * two shared photos prove nothing. Look at those pairs by eye.
 *
 * Each directory is one listing, named by its last path part (the listing
 * id, when labels.sh fetch wrote into <out>/<id>). Only img<N>.png files
 * count: crops and contact sheets are left out. Put the group's first name on
 * every member as "product" in finalists.json; rank.mjs then ranks the
 * product once and names the other listings with their prices.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const IMG = /^img\d+\.png$/;

/** listings: [{ name, hashes: [...] }]. Returns { pairs, groups }: every
 * pair that shares a photo, and the same-product groups in input order. */
export function photoGroups(listings) {
  const sets = listings.map((l) => ({ name: l.name, set: new Set(l.hashes) }));
  const pairs = [];
  for (let a = 0; a < sets.length; a++) {
    for (let b = a + 1; b < sets.length; b++) {
      let shared = 0;
      for (const h of sets[a].set) if (sets[b].set.has(h)) shared++;
      if (!shared) continue;
      const smaller = Math.min(sets[a].set.size, sets[b].set.size);
      pairs.push({ a: sets[a].name, b: sets[b].name, shared, photosA: sets[a].set.size, photosB: sets[b].set.size,
        same: shared >= Math.max(2, Math.ceil(smaller / 2)) });
    }
  }
  // Groups: listings joined by same-product pairs, any chain of them.
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
  return { pairs, groups: [...byRoot.values()].filter((g) => g.length > 1) };
}

const isMain = process.argv[1] && /same\.mjs$/.test(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const dirs = args.filter((a) => a !== '--json');
  const die = (m) => { console.error('same: ' + m); process.exit(2); };
  if (dirs.length < 2) die('usage: labels.sh same <dir> <dir> [dir...]  (one dir per listing, written by labels.sh fetch)');
  const listings = [];
  for (const d of dirs) {
    let files;
    try {
      if (!statSync(d).isDirectory()) die(d + ' is not a directory');
      files = readdirSync(d).filter((f) => IMG.test(f));
    } catch (e) { die(d + ': ' + e.message); }
    if (!files.length) die(d + ': no img<N>.png in it (run labels.sh fetch into it first)');
    const name = basename(d.replace(/\/+$/, ''));
    if (listings.some((l) => l.name === name)) die('two directories are named ' + name + ': one directory per listing id');
    listings.push({ name, hashes: files.map((f) => createHash('md5').update(readFileSync(join(d, f))).digest('hex')) });
  }
  const res = photoGroups(listings);
  if (json) console.log(JSON.stringify(res));
  else {
    for (const g of res.groups) {
      console.log('same product: ' + g.join(' ') + '   -> "product": "' + g[0] + '" on each');
      for (const p of res.pairs.filter((x) => x.same && g.includes(x.a))) {
        console.log('  ' + p.a + ' = ' + p.b + ': ' + p.shared + ' shared (of ' + p.photosA + ' and ' + p.photosB + ' distinct photos)');
      }
    }
    for (const p of res.pairs.filter((x) => !x.same)) {
      console.log('some photos in common: ' + p.a + ' ' + p.b + ': ' + p.shared + ' shared (of ' + p.photosA + ' and ' +
        p.photosB + '). Not enough to call them one product: compare by eye.');
    }
    if (!res.pairs.length) console.log('no photo in common: ' + listings.length + ' listings, ' + listings.length + ' products');
  }
}
