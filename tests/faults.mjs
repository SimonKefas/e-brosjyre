// A second origin for the tests: serves PDFs the way a file host can misbehave, so the viewer's loading states and error
// messages can be checked against real network behaviour (CORS, status codes, stalls, dropped connections, missing length).
// URL: /<mode>/<file>, e.g. /stall/demo.pdf. Query: chunk (bytes per write) and delay (ms between writes) trickle the body;
// key + fails make /flaky/ drop the first `fails` requests for that key and serve normally afterwards; /pause/ sends 1 kB, waits
// `pause` ms and sends the rest; /cut/ serves ranges but cuts the whole-file stream halfway. stor.pdf is a 1.5 MB document (six pages and an incompressible attachment) for throttled runs.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { PDFDocument } from 'pdf-lib';

let large;
async function bigPDF() {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 6; i++) pdf.addPage([595, 842]).drawText(`Side ${i + 1}`, { x: 60, y: 760, size: 40 });
  await pdf.attach(randomBytes(1_500_000), 'fyll.bin', { mimeType: 'application/octet-stream' });
  return Buffer.from(await pdf.save());
}
const files = { 'demo.pdf': 'dist/demo.pdf', 'passord.pdf': 'tests/fixtures/passord.pdf', 'katalog.pdf': 'public/lokal-katalog.pdf', 'demo.css': 'dist/demo.css' };
const attempts = new Map();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// "bytes=a-b" → [a, b] inside the file, or null when the header is absent or unusable.
export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start <= end && start < size ? [start, end] : null;
}

export async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const [, mode, name] = url.pathname.split('/');
  const cors = mode === 'cors' ? {} : { 'Access-Control-Allow-Origin': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'Access-Control-Allow-Headers': 'Range' }); return res.end(); }
  if (!files[name] && name !== 'stor.pdf') { res.writeHead(404, cors); return res.end(); }
  if (mode === 'hang') return; // Never answers.
  if (/^\d{3}$/.test(mode)) { res.writeHead(Number(mode), cors); return res.end('Feil'); }
  const body = name === 'stor.pdf' ? await (large ??= bigPDF()) : await readFile(files[name]);
  const key = url.searchParams.get('key');
  const failing = mode === 'flaky' && (attempts.set(key, (attempts.get(key) || 0) + 1).get(key) <= Number(url.searchParams.get('fails') || 1));
  // ok and cut serve byte ranges (cut drops the whole-file stream halfway); the other modes ignore Range and answer 200.
  const ranged = mode === 'ok' || mode === 'cut';
  const range = ranged ? parseRange(req.headers.range, body.length) : null;
  const [start, end] = range || [0, body.length - 1];
  // gzip: compressed whatever the request asked for, Content-Length the compressed size, no ranges.
  if (mode === 'gzip') { const zipped = gzipSync(body); res.writeHead(200, { ...cors, 'Content-Type': 'application/pdf', 'Content-Encoding': 'gzip', 'Content-Length': zipped.length }); return res.end(zipped); }
  const headers = { ...cors, 'Content-Type': name.endsWith('.css') ? 'text/css' : 'application/pdf', 'Cache-Control': 'no-store' };
  if (mode !== 'nolength') headers['Content-Length'] = end - start + 1;
  if (ranged) headers['Accept-Ranges'] = 'bytes';
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${body.length}`;
  res.writeHead(range ? 206 : 200, headers);
  const part = body.subarray(start, end + 1);
  if (req.method === 'HEAD') return res.end();
  // stall: the first bytes, then silence on an open connection. drop: half the file, then the connection is cut.
  if (mode === 'stall') return res.write(part.subarray(0, 1024));
  if (mode === 'pause') { res.write(part.subarray(0, 1024)); await wait(Number(url.searchParams.get('pause'))); return res.end(part.subarray(1024)); }
  if (mode === 'drop' || failing || (mode === 'cut' && start === 0 && end === body.length - 1)) { res.write(part.subarray(0, part.length >> 1)); await wait(50); return res.destroy(); }
  const chunk = Number(url.searchParams.get('chunk') || part.length), delay = Number(url.searchParams.get('delay') || 0);
  for (let i = 0; i < part.length; i += chunk) {
    if (i) await wait(delay);
    if (res.destroyed) return;
    res.write(part.subarray(i, i + chunk));
  }
  res.end();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT);
  createServer((req, res) => handle(req, res).catch(() => res.destroy())).listen(port, '127.0.0.1', () => console.log(`Feilserver: http://127.0.0.1:${port}`));
}
