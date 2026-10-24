// Bundles the browser front-end (web/) into dist/web.
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
mkdirSync('dist/web', { recursive: true });
cpSync('web/index.html', 'dist/web/index.html');
cpSync('web/style.css', 'dist/web/style.css');

const opts = {
  entryPoints: { app: 'web/main.ts' },
  bundle: true,
  format: 'esm',
  // The 3D view (three.js) is loaded on demand as a separate chunk.
  splitting: true,
  minify: !watch,
  target: 'es2022',
  sourcemap: true,
  outdir: 'dist/web',
  chunkNames: 'chunks/[name]-[hash]',
  logLevel: 'info',
};

if (watch) {
  const { context } = await import('esbuild');
  const ctx = await context(opts);
  await ctx.watch();
} else {
  await build(opts);
}
