// Bundles the browser front-end (web/) into dist/web.
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
mkdirSync('dist/web', { recursive: true });
cpSync('web/index.html', 'dist/web/index.html');
cpSync('web/style.css', 'dist/web/style.css');

const opts = {
  entryPoints: ['web/main.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  outfile: 'dist/web/app.js',
  logLevel: 'info',
};

if (watch) {
  const { context } = await import('esbuild');
  const ctx = await context(opts);
  await ctx.watch();
} else {
  await build(opts);
}
