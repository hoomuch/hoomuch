# hoomuch

All your subscription revenue under one roof. Connect **Stripe**, **Lemon Squeezy** and **RevenueCat** with
read-only keys, and see total MRR, ARR, active subscriptions, trials and revenue, converted into one currency
and broken down by connection.

- One Cloudflare Worker: Hono routes, React 19 pages rendered on the server and hydrated in the
  browser, D1, Cron Triggers.
- UI: [coss ui](https://coss.com/ui) on Base UI, shadcn Charts on Recharts, Lucide icons, Geist Sans and
  Geist Mono, Tailwind CSS 4, Motion where it helps.
- Forms are plain POST forms (Post/Redirect/Get), so every action works before the page hydrates.
  Scripts are same-origin only (CSP `script-src 'self'`).
- Provider keys are encrypted at rest (AES-256-GCM). No end-customer personal data is stored.
- Open source under [AGPL-3.0](LICENSE). Run it on your own Cloudflare account, so your keys never leave it.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/tahabozdemir/hoomuch)

The product and technical spec (in Turkish) is in [SPEC.md](SPEC.md).

## Run locally

Requirements: Node 20+.

```bash
npm install
cp .dev.vars.example .dev.vars          # then set ENCRYPTION_KEY, e.g. openssl rand -base64 32
npm run db:migrate:local
npm run dev                             # http://localhost:8787
```

Sign up, then click **Try demo data** to see a filled dashboard without any API key.

The cron sync doesn't fire automatically in local dev. To trigger it by hand:

```bash
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*/30+*+*+*+*"
```

## Deploy to Cloudflare

### One click

Click **Deploy to Cloudflare** above. Cloudflare copies this repo into your GitHub or GitLab account,
creates the D1 database and asks for `ENCRYPTION_KEY` (generate one with `openssl rand -base64 32`).
Every deploy applies pending D1 migrations first, and every push to your copy redeploys it.

### By hand

```bash
npx wrangler login
npx wrangler d1 create hoomuch       # copy the printed database_id into wrangler.jsonc
openssl rand -base64 32 | npx wrangler secret put ENCRYPTION_KEY
npm run deploy                          # applies D1 migrations, then deploys
```

### After deploying

- **Back up `ENCRYPTION_KEY`.** If it's lost, every stored provider key becomes unreadable and each
  connection has to be re-keyed. Never rotate it in place.
- **Single-user / self-hosted:** create your account, then set `"ALLOW_SIGNUP": "false"` in
  `wrangler.jsonc` and deploy again (with the button, commit that change to your copy of the repo).
- **Plan:** password hashing (PBKDF2, 100k iterations) and syncs can exceed the Free plan's 10 ms CPU
  limit. Workers Paid is recommended for production.

## Connecting providers

| Provider | Key | Permissions |
|----------|-----|-------------|
| Stripe | Restricted key `rk_live_…` | Read: Subscriptions, Prices, Coupons, Balance |
| Lemon Squeezy | API key (can't be scoped, so it has full access) | — |
| RevenueCat | v2 secret key `sk_…` + Project ID | `charts_metrics:overview:read`; `charts_metrics:charts:read` is optional and enables daily revenue history |

Keys are checked live before they're saved. Syncs run every 30 minutes, with each connection synced at
most once per `SYNC_INTERVAL_MINUTES` (default 60). You can also press **Sync now**. The first sync
backfills 90 days of revenue.

## Scripts

| Script | What it does |
|--------|--------------|
| `npm run dev` | `wrangler dev`. Rebuilds the CSS and the browser bundle on every reload |
| `npm run check` | Typecheck, tests and build |
| `npm test` | Vitest: adapters, sync engine and read models run on an in-memory D1 |
| `npm run build` | `css` + `js` |
| `npm run css` | Builds `public/app.css` with the Tailwind CLI |
| `npm run js` | Builds the browser bundle into `public/client/` with esbuild (code-split per page) |
| `npm run deploy` | Applies remote D1 migrations, then `wrangler deploy` |
| `npm run db:migrate:local` / `:remote` | Applies the D1 migrations |
| `npm run cf-typegen` | Regenerates `worker-configuration.d.ts` |

## Layout

```
src/
  index.tsx          middleware (CSP, CSRF, session, flash) and cron entry
  lib/               crypto, auth, money, time, flash
  db/queries.ts      users, sessions, connections
  providers/         adapter contract, registry, Stripe / Lemon Squeezy / RevenueCat / Demo
  sync/              sync engine, aggregation, FX (frankfurter.dev), repository
  data/              read models for the dashboard, transactions and connection detail
  services/          connection use-cases: create, rotate key, sync now, delete
  routes/            HTTP handlers (Post/Redirect/Get); pages render with views/render.tsx
  views/             layout, pages, hoomuch components, charts (React)
  components/ui/     coss ui components (copied in with the shadcn CLI; components.json)
  client/entry.tsx   browser entry: hydrates the page the server rendered
  styles/app.css     Tailwind theme: coss tokens with hoomuch's palette, Geist
migrations/          D1 schema
test/                Vitest suites and API fixtures
```

## Known limitations (v1)

- Stripe: tiered prices count as 0 MRR, and customer-level discounts aren't applied.
- Lemon Squeezy: discount codes aren't reflected in MRR, and refunds issued more than about 30 days
  after purchase are missed.
- RevenueCat: daily history is in USD only, and test mode can't be detected.
- Past revenue is converted at today's FX rate. Day boundaries are UTC.
- Provider webhooks and Queue-based fan-out are planned for v1.1 (SPEC §12.1).

## Contributing

Bug reports, fixes and new provider adapters (Paddle, Polar, Gumroad, …) are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

hoomuch is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only).

You can use, self-host and modify it freely. If you run a **modified** version as a service other people
use, the AGPL requires you to offer those users your modified source code. The footer of every page
links to the source; point it at your fork (`SOURCE_URL` in `src/views/layout.tsx`).
