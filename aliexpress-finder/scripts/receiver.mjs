#!/usr/bin/env node
/* Local receiver for harvest payloads — the export channel that needs no
 * retyping and no chunking, in either browser.
 *
 *   node receiver.mjs --dir <outdir> [--port 8765] [--count 0] [--idle 3600] [--token <token>] [--max-bytes N]
 *
 * Prints one line, `listening http://127.0.0.1:<port> dir <dir> token <token>`,
 * then waits. <port> is 8765 unless that port is in use: then the next free
 * one, named at the end of the line (A BUSY PORT, below). The page POSTs its payload with
 * `await __aeHarvest.send(<port>, {via: 'form', token: '<token>'})` after
 * `curl -s http://127.0.0.1:<port>/` answers ok (a plain send() fetch was
 * refused by both browsers on 2026-10-18; see SKILL.md step 3).
 *
 * THE TOKEN (added 2026-11-09, review of 9e11593). A payload is saved only
 * when it is POSTed to /harvest/<token>. The token is random per run (or
 * --token), printed only in the "listening" line, and never in a reply. Any
 * web page open in the browser could POST here: CORS is open, and the
 * receiver answers Chrome's private-network preflight. A test POST with
 * `Origin: https://evil.example` was saved as harvest-wired-usb-mouse-….json,
 * which `decode.mjs harvest-*.json` then merges into the search pool. The
 * Origin header cannot tell the two apart: a form POST from an https page to
 * http://127.0.0.1 carries `Origin: null` (Fetch standard, "append a request
 * Origin header": a downgrade to http under the default referrer policy), so
 * the real AliExpress form and a hostile one look the same. Only a secret the
 * page cannot read tells them apart. A body over --max-bytes is refused (413).
 *
 * The body is validated as a payload and written to
 *   <dir>/harvest-<query-slug>-<timestamp>.json   a search payload (harvest.js, decode.mjs)
 *   <dir>/<kind>-<timestamp>.json                 a payload that names its `kind` (the detail
 *                                                 records of __aeListing.sendAll(): details-…)
 *   <dir>/page-<timestamp>.json                   anything else: the one page of extract.js
 * and the receiver prints `saved <path>` in its own output. Only search
 * payloads are named harvest-*, so `decode.mjs harvest-*.json` takes in no
 * other kind of file (decode.mjs refuses the others too). With the form,
 * that line is the only proof of delivery: send() answers UNCONFIRMED, and
 * the reply page the tab navigates to cannot be read in a hidden tab. A
 * fetch gets the same `saved <path>` line back as its reply.
 * Exits after --idle seconds without a request (default 3600), or after
 * --count payloads when --count is above 0 (default 0: no limit), so a
 * forgotten receiver does not outlive the session. `curl -s
 * http://127.0.0.1:<port>/stop` ends it at once, with exit 0. A /stop that a
 * web page sends (it carries Origin, or a Sec-Fetch-Site other than "none")
 * is refused with 403: any page in the browser could stop the receiver in the
 * middle of a harvest (review of 58c8a00). curl sends neither header, and an
 * address typed in the browser sends Sec-Fetch-Site: none.
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
 * A BUSY PORT (measured 2026-11-26): a Python web server of another project
 * held 8765. The receiver exited 1 with "listen EADDRINUSE", and
 * `curl -s http://127.0.0.1:8765/` answered with that server's HTML directory
 * listing, so the curl check did not show at once that no receiver was up.
 * Now the CLI tries the next ports, up to PORT_TRIES in all (8765 to 8784),
 * and the "listening" line names the port it took and who held the busy one:
 * "another receiver.mjs" when that port answers GET / with "ok … saved",
 * "another program" otherwise. Read the port from that line, as the token.
 * --port 0 takes a free port the system picks, with no fallback needed.
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
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/* A token: letters and digits only, so it can be typed into a send() call
 * and sits in a URL path with no escaping. 16 hex digits are 64 random bits. */
export const TOKEN_RE = /^[0-9A-Za-z]{8,64}$/;
export const newToken = () => randomBytes(8).toString('hex');
/* 64 MiB. A full 60-page harvest is about 2 MB (500 chars per item, 3,600
 * items), and the detail records of 40 finalists a few MB more. */
export const MAX_BYTES = 64 * 1024 * 1024;
/* Ports the CLI tries, from --port up: 8765 to 8784 by default. */
export const PORT_TRIES = 20;

/** Who holds a busy port: 'receiver' when it answers GET / like this
 * receiver ("ok <n> saved, idle …"), 'other' when it answers anything else
 * or nothing within a second. The probe sends no token. */
export async function whoHolds(port) {
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(1000) });
    const t = await r.text();
    return /^ok \d+(\/\d+)? saved, idle /.test(t) ? 'receiver' : 'other';
  } catch (e) { return 'other'; }
}

/** One line about the busy ports, for the "listening" line; '' when none. */
export function busyNote(busy, took) {
  if (!busy || !busy.length) return '';
  const who = (b) => b.port + ' (' + (b.holder === 'receiver' ? 'another receiver.mjs' : 'another program') + ')';
  return 'Port ' + busy.map(who).join(', ') + (busy.length > 1 ? ' are' : ' is') + ' in use: this receiver took ' +
    took + '. Use ' + took + ' in place of ' + busy[0].port + ' in every curl and send().';
}

/* --name value or --name=value. An unknown flag is an error: "--idle=1"
 * and typos used to be ignored, so the receiver ran with the defaults.
 * A flag with no value and a stray word are errors too (exit 2). They used
 * to pass with exit 0 (review 2026-10-18, finding F08): `--dir --port 8765`
 * (what `--dir $OUT` becomes when OUT is unset) took "--port" as the
 * directory and saved there, and `receiver.mjs <dir> --port N` ignored <dir>
 * and saved into the cwd. A value that starts with "--" is taken only in the
 * --name=value form. When a flag is given twice, the first one counts.
 * Returns { opts, error }: error is null or the message to print. */
const FLAGS = ['dir', 'port', 'count', 'idle', 'token', 'max-bytes'];
export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (!a.startsWith('--')) {
      return { opts, error: 'stray argument ' + JSON.stringify(a) + ': every value goes after its flag, e.g. --dir <dir>' };
    }
    const eqAt = a.indexOf('=');
    const name = a.slice(2, eqAt >= 0 ? eqAt : undefined);
    if (!FLAGS.includes(name)) return { opts, error: 'unknown flag --' + name + ' (known: --' + FLAGS.join(', --') + ')' };
    let v;
    if (eqAt >= 0) v = a.slice(eqAt + 1);
    else {
      v = argv[i + 1];
      if (v == null || String(v).startsWith('--')) {
        return { opts, error: '--' + name + ' needs a value' + (v == null ? '' : ', but the next word is the flag ' + v +
          ' (an unset shell variable?)') };
      }
      i++;
    }
    if (!(name in opts)) opts[name] = String(v);
  }
  return { opts, error: null };
}

export function slugify(q) {
  return String(q || 'payload').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'payload';
}

/** The file name, before the stamp: see the header. A search payload is
 * harvest.js's ('harvest-paged'), a decode.mjs merge ('merged'), or an old
 * one with a query and no source. extract.js payloads (source 'init-data' or
 * 'dom', no query) were saved as harvest-payload-<stamp>.json, and the
 * `decode.mjs harvest-*.json` of SKILL.md merged a page with no query into
 * the search pool (review of 58c8a00). */
export function fileBase(p) {
  if (p.kind) return slugify(p.kind).slice(0, 40);
  const search = p.source === 'harvest-paged' || p.source === 'merged' || (p.source == null && p.query != null);
  return search ? 'harvest-' + slugify(p.query).slice(0, 80) : 'page';
}

/** A /stop sent by a web page: it carries Origin, or Sec-Fetch-Site other than "none". */
export function fromWebPage(headers) {
  const site = headers['sec-fetch-site'];
  return headers.origin != null || (site != null && site !== 'none');
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

/** The token a POST names: /harvest/<token>, '' when it names none. */
export function tokenOf(url) {
  const path = String(url || '').split('?')[0].replace(/\/+$/, '');
  return path.startsWith('/harvest/') ? path.slice('/harvest/'.length) : '';
}

/* tries: how many ports to try, from `port` up, when one is in use. 1 (the
 * default here) keeps the old behaviour: EADDRINUSE rejects. The CLI passes
 * PORT_TRIES. Port 0 is one try: the system picks a free port. */
export function startReceiver({ dir, port = 0, count = 0, idle = 3600, log = () => {}, token = newToken(), maxBytes = MAX_BYTES, tries = 1 }) {
  if (!TOKEN_RE.test(String(token))) throw new Error('the token must be 8 to 64 letters or digits');
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
    /* GET /stop ends it with exit 0. The only other way out was the 60-minute
     * idle timer or a kill, and a killed receiver shows as a FAILED background
     * task (exit 144, measured 2026-11-08). */
    if (req.method === 'GET' && /^\/stop\/?(\?|$)/.test(req.url || '')) {
      if (fromWebPage(req.headers)) {
        res.writeHead(403, cors);
        res.end('stop refused: it must come from a terminal (curl), not a web page');
        log('refused a /stop from a web page (' + (req.headers.origin || req.headers['sec-fetch-site']) + ')');
        return;
      }
      res.writeHead(200, cors);
      res.end('stopping: ' + received + ' saved');
      log('stopped by GET /stop after ' + received + ' payload(s)');
      if (timer) clearTimeout(timer);
      setTimeout(() => server.close(), 50);
      return;
    }
    if (req.method === 'GET') {
      res.writeHead(200, cors);
      res.end('ok ' + received + (count > 0 ? '/' + count : '') + ' saved, idle ' + idle + ' s from now');
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405, cors); res.end('POST /harvest/<token>'); return; }
    // Checked before the body is read. The reply never holds the token.
    const given = tokenOf(req.url);
    if (given !== token) {
      res.writeHead(403, cors);
      res.end('not saved: ' + (given ? 'wrong' : 'no') + ' token. Post to the address with the token printed in the ' +
        'receiver\'s "listening" line: send(<port>, {via: \'form\', token: \'<token>\'})');
      log('refused a POST with ' + (given ? 'a wrong token' : 'no token') + ' (origin ' + (req.headers.origin || 'none') + ')');
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0, over = false;
    req.on('data', (c) => {
      if (over) return; // drained, never kept
      size += c.length;
      if (size <= maxBytes) { chunks.push(c); return; }
      over = true; chunks.length = 0;
      res.writeHead(413, cors); res.end('not saved: the body is over ' + maxBytes + ' bytes');
      log('refused a body over ' + maxBytes + ' bytes');
    });
    req.on('end', () => {
      if (over) return;
      const text = Buffer.concat(chunks).toString('utf8');
      const v = validate(text);
      if (v.err) { res.writeHead(400, cors); res.end(v.err); log('rejected: ' + v.err); return; }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      // Two payloads in one millisecond used to share a name, and the second
      // overwrote the first while both were answered "saved".
      /* A payload with a `kind` is not a search payload. The detail records
       * of sendAll() were saved as harvest-details-<stamp>.json, so the
       * `decode.mjs harvest-*.json` of SKILL.md merged them into the search
       * pool with exit 0 and no warning: a stream with no query, and detail
       * prices over grid prices (measured 2026-11-08). See fileBase(). */
      const base = join(dir, fileBase(v.payload) + '-' + stamp);
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
  /* One listen() at a time. After a failed listen(), Node allows listen()
   * again on the same server. */
  const listenOn = (p) => new Promise((ok, fail) => {
    const onErr = (e) => { server.off('listening', onOk); fail(e); };
    const onOk = () => { server.off('error', onErr); ok(); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(p, '127.0.0.1');
  });
  return (async () => {
    const busy = [];
    const last = port === 0 ? 0 : Math.min(65535, port + Math.max(1, tries) - 1);
    for (let p = port; ; p++) {
      try { await listenOn(p); break; } catch (e) {
        if (e.code !== 'EADDRINUSE' || p >= last) {
          if (e.code === 'EADDRINUSE' && busy.length) {
            busy.push({ port: p, holder: await whoHolds(p) });
            throw new Error('ports ' + port + ' to ' + last + ' are all in use (' +
              busy.map((b) => b.port + ': ' + (b.holder === 'receiver' ? 'another receiver.mjs' : 'another program')).join(', ') +
              '). Stop one, or pass --port <another>');
          }
          throw e;
        }
        busy.push({ port: p, holder: await whoHolds(p) });
      }
    }
    server.on('error', (e) => log('server error: ' + e.message));
    arm();
    // The CLI puts busyNote() at the end of its "listening" line, so that line stays the first one.
    return { port: server.address().port, token, busy, close: () => new Promise((r) => server.close(r)), server };
  })();
}

const isMain = process.argv[1] && /receiver\.mjs$/.test(process.argv[1]);
if (isMain) {
  const { opts, error } = parseArgs(process.argv.slice(2));
  if (error) { console.error('receiver: ' + error); process.exit(2); }
  const arg = (name, dflt) => (name in opts ? opts[name] : dflt);
  // --dir "" (a quoted unset variable) used to resolve to the cwd.
  if (opts.dir != null && !opts.dir.trim()) { console.error('receiver: --dir is empty (an unset shell variable?): name the directory to write into'); process.exit(2); }
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
  const maxBytes = whole('max-bytes', arg('max-bytes', MAX_BYTES), 1, 1024 * 1024 * 1024);
  // --token keeps one token across a restart; without it, a new one per run.
  if (opts.token != null && !TOKEN_RE.test(opts.token)) {
    console.error('receiver: --token must be 8 to 64 letters or digits, got ' + JSON.stringify(opts.token)); process.exit(2);
  }
  const token = opts.token != null ? opts.token : newToken();
  startReceiver({ dir, port, count, idle, token, maxBytes, tries: PORT_TRIES, log: (m) => console.log(m) })
    .then(({ port: p, busy }) => console.log('listening http://127.0.0.1:' + p + ' dir ' + dir + ' token ' + token +
      (count > 0 ? ' (exits after ' + count + ' payload(s)' : ' (no payload limit') + ', or ' + idle + ' s idle)' +
      '. Send with token: \'' + token + '\'' + (busy.length ? '. ' + busyNote(busy, p) : '')))
    .catch((e) => { console.error('receiver: ' + e.message); process.exit(1); });
}
