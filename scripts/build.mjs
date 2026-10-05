import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { generateDemo } from './demo-pdf.mjs';
await rm('dist', { recursive: true, force: true });
await mkdir('dist/pdfjs', { recursive: true });
// Local-only test material (see .gitignore) must never reach the publish bundle: dist/ is meant to be uploaded as-is.
const localOnly = new Set(['lokal-katalog.pdf']);
await cp('public', 'dist', { recursive: true, filter: source => !localOnly.has(basename(source)) });
await cp('LICENSE', 'dist/LICENSE');
await cp('README.md', 'dist/README.md');
await build({ entryPoints: ['src/viewer.js'], outfile: 'dist/ebrosjyre.js', bundle: true, format: 'esm', minify: true, target: ['es2022'], loader: { '.css': 'text' }, legalComments: 'linked' });
await cp('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'dist/pdfjs/pdf.worker.min.mjs');
for (const name of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) await cp(`node_modules/pdfjs-dist/${name}`, `dist/pdfjs/${name}`, { recursive: true });
await cp('node_modules/pdfjs-dist/LICENSE', 'dist/pdfjs/LICENSE');
await generateDemo('dist/demo.pdf');
console.log('Bygget dist/ — klar for statisk hosting.');
