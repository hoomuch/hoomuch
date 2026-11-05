// Builds the browser bundle: src/client/entry.tsx → public/client/entry.js (+ shared chunks).
// `--watch` rebuilds on change. Run by `npm run build`, before every dev reload and deploy.
import { rm } from 'node:fs/promises';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const outdir = 'public/client';
await rm(outdir, { recursive: true, force: true });

const options = {
  entryPoints: ['src/client/entry.tsx'],
  bundle: true,
  splitting: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  jsx: 'automatic',
  outdir,
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
