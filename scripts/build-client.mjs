// Builds the browser bundle: src/client/entry.tsx → public/client/entry.js (+ shared chunks).
// `--watch` rebuilds on change. Run by `npm run build`, before every dev reload and deploy.
//
// A build never deletes public/client. Every `wrangler dev` started in this folder runs
// `npm run build` when src changes, so several builds can overlap; when one deleted the folder,
// a server whose asset watcher saw it vanish kept answering 404 for /client/entry.js (no
// hydration at all) until it was restarted. So instead:
//  1. each file is written to a temp name and renamed into place (atomic per file),
//  2. chunks first and entry.js last, so entry.js never points at a chunk that isn't there yet,
//  3. then files from older builds are pruned: anything this build didn't write that is older
//     than this build's start. A newer build running alongside keeps its own chunks.
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const outdir = 'public/client';

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

/** Temp files are dot-files next to their target (same folder, so the rename is atomic). */
const TMP = /^\..+\.\d+\.tmp$/;
/** Another build's temp file is only debris once it's this old. */
const TMP_MAX_AGE_MS = 60_000;

/** Removes files not in `keep` that were last written before `before` (epoch ms). */
async function prune(dir, keep, before) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) {
      await prune(file, keep, before);
      continue;
    }
    if (keep.has(file)) continue;
    const s = await stat(file).catch(() => null);
    if (!s) continue;
    const cutoff = TMP.test(e.name) ? Date.now() - TMP_MAX_AGE_MS : before;
    if (s.mtimeMs < cutoff) await rm(file, { force: true });
  }
}

if (watch) {
  // One long-lived process: start clean, then esbuild rewrites in place.
  await rm(outdir, { recursive: true, force: true });
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  const started = Date.now();
  const result = await esbuild.build({ ...options, write: false });
  const entry = path.resolve(outdir, 'entry.js');
  const files = [...result.outputFiles].sort((a, b) => Number(a.path === entry) - Number(b.path === entry));
  for (const f of files) {
    const dir = path.dirname(f.path);
    await mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(f.path)}.${process.pid}.tmp`);
    await writeFile(tmp, f.contents);
    await rename(tmp, f.path);
  }
  await prune(path.resolve(outdir), new Set(files.map((f) => f.path)), started);
  const kb = files.reduce((n, f) => n + f.contents.byteLength, 0) / 1024;
  console.log(`client: ${files.length} files, ${kb.toFixed(1)} KB → ${outdir}/`);
}
