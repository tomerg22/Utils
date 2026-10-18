#!/usr/bin/env node
/* Local receiver for harvest payloads — the export channel that needs no
 * retyping and no chunking, in either browser.
 *
 *   node receiver.mjs --dir <outdir> [--port 8765] [--count 0] [--idle 3600]
 *
 * Prints one line, `listening http://127.0.0.1:<port> dir <dir>`, then waits.
 * The page POSTs its payload with `await __aeHarvest.send(<port>)`; the body is
 * validated as a harvest payload and written to
 *   <dir>/harvest-<query-slug>-<timestamp>.json
 * and the saved path goes back to the page, so the tool result names the file.
 * Exits after --idle seconds without a request (default 3600), or after
 * --count payloads when --count is above 0 (default 0: no limit), so a
 * forgotten receiver does not outlive the session.
 *
 * WHY THESE DEFAULTS (measured 2026-10-17): the defaults used to be one
 * payload and 900 s. The hidden-tab recovery needs TWO sends (the stuck tab,
 * then the fresh one), and the receiver had already exited after the first;
 * the idle timer is reset only by requests to the receiver, never by the
 * harvest's own fetches to AliExpress, so a harvest that waited on the user
 * for a wall screenshot passed 15 minutes and found the port closed. A
 * refused send() then lost the harvest. `GET /` answers "ok <saved> idle
 * <seconds left>", so `curl -s http://127.0.0.1:8765/` checks it is up.
 *
 * WHY (measured 2026-09-14): the Chrome connector cuts a javascript_tool
 * result at 1,000 characters and get_page_text at 50,000, so a 90 KB payload
 * could only come back as chunks pasted by hand. A page may POST to
 * 127.0.0.1 from an https origin (loopback is "potentially trustworthy", so it
 * is not mixed content), and a text/plain POST is a CORS "simple request" that
 * needs only Access-Control-Allow-Origin on the reply. So the payload goes
 * straight from the page to disk.
 */
import http from 'node:http';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/* --name value or --name=value. An unknown flag is an error: "--idle=1"
 * and typos used to be ignored, so the receiver ran with the defaults. */
const FLAGS = ['dir', 'port', 'count', 'idle'];
const ARGV = process.argv.slice(2).flatMap((a) => (/^--[a-z]+=/.test(a) ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a]));
function arg(name, dflt) {
  const i = ARGV.indexOf('--' + name);
  return i >= 0 && ARGV[i + 1] != null ? ARGV[i + 1] : dflt;
}

export function slugify(q) {
  return String(q || 'payload').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'payload';
}

/** Accept only something shaped like a harvest/extract payload. The body may
 * be raw JSON (fetch) or a text/plain FORM submission, which arrives as
 * `payload=<json>\r\n` — a top-level form POST is how the page reaches
 * loopback when Chrome holds fetch() behind its local-network permission. */
export function unwrap(text) {
  const s = String(text);
  if (/^\s*[{[]/.test(s)) return s.trim();
  const eq = s.indexOf('=');
  return eq >= 0 ? s.slice(eq + 1).trim() : s.trim();
}

export function validate(text) {
  let j;
  const body = unwrap(text);
  try { j = JSON.parse(body); } catch (e) { return { err: 'body is not JSON' }; }
  if (!j || typeof j !== 'object' || !Array.isArray(j.items)) return { err: 'JSON has no items[] — not a payload' };
  return { payload: j, body };
}

export function startReceiver({ dir, port = 0, count = 0, idle = 3600, log = () => {} }) {
  mkdirSync(dir, { recursive: true });
  let received = 0;
  let timer = null;
  /* Access-Control-Allow-Private-Network answers Chrome's Private Network
   * Access preflight: a public https page reaching a loopback address gets a
   * preflight with Access-Control-Request-Private-Network: true, and without
   * this reply header the request is refused. */
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Private-Network': 'true',
    'Content-Type': 'text/plain; charset=utf-8' };
  const server = http.createServer((req, res) => {
    arm();
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    if (req.method === 'GET') {
      res.writeHead(200, cors);
      res.end('ok ' + received + (count > 0 ? '/' + count : '') + ' saved, idle ' + idle + ' s from now');
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405, cors); res.end('POST /harvest'); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const v = validate(text);
      if (v.err) { res.writeHead(400, cors); res.end(v.err); log('rejected: ' + v.err); return; }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      // Two payloads in one millisecond used to share a name, and the second
      // overwrote the first while both were answered "saved".
      const base = join(dir, 'harvest-' + slugify(v.payload.query).slice(0, 80) + '-' + stamp);
      let file = base + '.json';
      for (let n = 2; existsSync(file); n++) file = base + '-' + n + '.json';
      // A write error (dir removed, disk full) answers 500 and keeps the
      // receiver up; it used to crash it, and every later send was refused.
      try { writeFileSync(file, v.body); } catch (e) {
        res.writeHead(500, cors); res.end('not saved: ' + String(e.message || e).slice(0, 160));
        log('write failed: ' + e.message); return;
      }
      received++;
      res.writeHead(200, cors);
      res.end('saved ' + file + ' (' + v.body.length + ' chars, ' + v.payload.items.length + ' items)');
      log('saved ' + file);
      if (count > 0 && received >= count) setTimeout(() => server.close(), 50);
    });
  });
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { log('idle timeout after ' + idle + ' s: exiting'); server.close(); }, idle * 1000);
    timer.unref && timer.unref();
  };
  return new Promise((resolveP, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      arm();
      resolveP({ port: server.address().port, close: () => new Promise((r) => server.close(r)), server });
    });
  });
}

const isMain = process.argv[1] && /receiver\.mjs$/.test(process.argv[1]);
if (isMain) {
  for (let i = 0; i < ARGV.length; i++) {
    if (!ARGV[i].startsWith('--')) continue;
    if (!FLAGS.includes(ARGV[i].slice(2))) { console.error('receiver: unknown flag ' + ARGV[i] + ' (known: --' + FLAGS.join(', --') + ')'); process.exit(2); }
    i++;
  }
  const dir = resolve(arg('dir', '.'));
  /* Whole numbers in range only. '' (an unset shell variable) used to be
   * Number('') = 0, a random port; an --idle past 2147483 s overflows
   * setTimeout, which Node turns into 1 ms, and the receiver exited right
   * after printing "listening" (review of the fix, 2026-10-18). */
  const whole = (name, v, min, max) => {
    const n = /^\s*\d+\s*$/.test(String(v)) ? Number(v) : NaN;
    if (!(n >= min && n <= max)) {
      console.error('receiver: --' + name + ' must be a whole number from ' + min + ' to ' + max + ', got ' + JSON.stringify(v));
      process.exit(2);
    }
    return n;
  };
  const port = whole('port', arg('port', 8765), 0, 65535);
  const count = whole('count', arg('count', 0), 0, 1e9);
  const idle = whole('idle', arg('idle', 3600), 1, 2147483);
  startReceiver({ dir, port, count, idle, log: (m) => console.log(m) })
    .then(({ port: p }) => console.log('listening http://127.0.0.1:' + p + ' dir ' + dir +
      (count > 0 ? ' (exits after ' + count + ' payload(s)' : ' (no payload limit') + ', or ' + idle + ' s idle)'))
    .catch((e) => { console.error('receiver: ' + e.message); process.exit(1); });
}
