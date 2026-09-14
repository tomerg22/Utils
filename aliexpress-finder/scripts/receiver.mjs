#!/usr/bin/env node
/* Local receiver for harvest payloads — the export channel that needs no
 * retyping and no chunking, in either browser.
 *
 *   node receiver.mjs --dir <outdir> [--port 8765] [--count 1] [--idle 900]
 *
 * Prints one line, `listening http://127.0.0.1:<port> dir <dir>`, then waits.
 * The page POSTs its payload with `await __aeHarvest.send(<port>)`; the body is
 * validated as a harvest payload and written to
 *   <dir>/harvest-<query-slug>-<timestamp>.json
 * and the saved path goes back to the page, so the tool result names the file.
 * Exits after --count payloads (default 1) or --idle seconds without a request
 * (default 900), so a forgotten receiver does not outlive the session.
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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : dflt;
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

export function startReceiver({ dir, port = 0, count = 1, idle = 900, log = () => {} }) {
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
    if (req.method === 'GET') { res.writeHead(200, cors); res.end('ok ' + received + '/' + count); return; }
    if (req.method !== 'POST') { res.writeHead(405, cors); res.end('POST /harvest'); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const v = validate(text);
      if (v.err) { res.writeHead(400, cors); res.end(v.err); log('rejected: ' + v.err); return; }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = join(dir, 'harvest-' + slugify(v.payload.query) + '-' + stamp + '.json');
      writeFileSync(file, v.body);
      received++;
      res.writeHead(200, cors);
      res.end('saved ' + file + ' (' + v.body.length + ' chars, ' + v.payload.items.length + ' items)');
      log('saved ' + file);
      if (received >= count) setTimeout(() => server.close(), 50);
    });
  });
  const arm = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { log('idle timeout'); server.close(); }, idle * 1000); timer.unref && timer.unref(); };
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
  const dir = resolve(arg('dir', '.'));
  const port = Number(arg('port', 8765));
  const count = Number(arg('count', 1));
  const idle = Number(arg('idle', 900));
  startReceiver({ dir, port, count, idle, log: (m) => console.log(m) })
    .then(({ port: p }) => console.log('listening http://127.0.0.1:' + p + ' dir ' + dir))
    .catch((e) => { console.error('receiver: ' + e.message); process.exit(1); });
}
