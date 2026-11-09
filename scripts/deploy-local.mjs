#!/usr/bin/env node
// Deploys with your own settings kept out of wrangler.jsonc: wrangler.local.jsonc (gitignored) is
// applied over wrangler.jsonc, so pulling a new release never conflicts with your database id,
// domain or mail sender. wrangler.local.example.jsonc shows what goes in it.
//
//   npm run deploy:local                           applies pending D1 migrations, then deploys
//   npm run deploy:local -- --dry-run              builds and checks the Worker, uploads nothing
//   npm run deploy:local -- --secrets-file <file>  uploads the secrets in <file> with the deploy
//
// Objects merge key by key, binding lists (d1_databases, ...) merge by `binding`, and anything else
// replaces what wrangler.jsonc says. Anything after `--` goes to `wrangler deploy`. The merged
// config is written to .wrangler-merged.json in the repo root, so its paths resolve as
// wrangler.jsonc's do. It's gitignored too, and every run writes it afresh.
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { experimental_readRawConfig as readRawConfig } from 'wrangler';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const BASE = 'wrangler.jsonc';
const LOCAL = 'wrangler.local.jsonc';
const EXAMPLE = 'wrangler.local.example.jsonc';
const OUT = '.wrangler-merged.json';
const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000';

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isBindingList = (v) => Array.isArray(v) && v.every((e) => isObject(e) && typeof e.binding === 'string');

/** Objects merge key by key, binding lists merge by `binding`, anything else is replaced. */
function merge(base, over) {
  if (isObject(base) && isObject(over)) {
    const out = { ...base };
    for (const [key, value] of Object.entries(over)) out[key] = key in base ? merge(base[key], value) : value;
    return out;
  }
  if (isBindingList(base) && isBindingList(over)) {
    const out = base.map((entry) => {
      const match = over.find((o) => o.binding === entry.binding);
      return match ? merge(entry, match) : entry;
    });
    for (const o of over) if (!base.some((entry) => entry.binding === o.binding)) out.push(o);
    return out;
  }
  return over;
}

function fail(message) {
  console.error(`deploy:local: ${message}`);
  process.exit(1);
}

function run(args) {
  const r = spawnSync('npx', ['wrangler', ...args, '--config', OUT], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!existsSync(LOCAL)) fail(`${LOCAL} not found. Copy ${EXAMPLE} to ${LOCAL} and fill it in.`);

const config = merge(readRawConfig({ config: BASE }).rawConfig, readRawConfig({ config: LOCAL }).rawConfig);

const unset = (config.d1_databases ?? []).filter((db) => !db.database_id || db.database_id === PLACEHOLDER_ID);
if (unset.length > 0) {
  fail(`${unset.map((db) => db.binding).join(', ')} has no database_id. Put the id from \`wrangler d1 create\` in ${LOCAL}.`);
}

writeFileSync(OUT, `${JSON.stringify(config, null, 2)}\n`);

const deployArgs = process.argv.slice(2);
if (!deployArgs.includes('--dry-run')) run(['d1', 'migrations', 'apply', 'DB', '--remote']);
run(['deploy', ...deployArgs]);
