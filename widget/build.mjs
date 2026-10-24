import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const outfile = resolve(process.cwd(), '../server/public/widget.js');
await mkdir(dirname(outfile), { recursive: true });
await build({ entryPoints: ['src/index.js'], outfile, bundle: true, minify: true, target: 'es2018', format: 'iife' });
console.log(`Built ${outfile}`);
