import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
const root = resolve('dist');
// Local-only test material is kept out of dist/ so the publish bundle stays clean; serve it from public/ during development.
const localRoot = resolve('public');
const port = Number(process.env.KAI_PREVIEW_PORT || process.env.PORT || 4173);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml' };
createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let file = resolve(root, `.${pathname}`);
    if (!file.startsWith(root + sep) && file !== root) throw new Error('Invalid path');
    const fallback = resolve(localRoot, `.${pathname}`);
    if (!(await stat(file).catch(() => null)) && fallback.startsWith(localRoot + sep)) file = fallback;
    if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
    res.end(data);
  } catch { res.writeHead(404); res.end('Ikke funnet'); }
}).listen(port, '127.0.0.1', () => console.log(`E-brosjyre: http://127.0.0.1:${port}`));
