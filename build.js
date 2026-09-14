import { build } from 'esbuild';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await build({ entryPoints: ['web/app.js', 'web/style.css'], outdir: 'dist', bundle: true, minify: true, format: 'esm', legalComments: 'external' });
await copyFile('web/index.html', 'dist/index.html');
await copyFile('node_modules/three/LICENSE', 'dist/app.js.LEGAL.txt');
await writeFile('dist/.nojekyll', '');