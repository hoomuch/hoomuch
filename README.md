# hoomuch

All your subscription revenue under one roof. Connect **Stripe**, **Paddle**, **Lemon Squeezy**, **Polar**,
**RevenueCat**, **Chargebee**, **Dodo Payments**, **Gumroad**, **Adapty** and **Superwall**, and see total MRR,
ARR, active subscriptions, trials and revenue, converted into one currency and broken down by connection.
hoomuch only ever reads, and asks for read-only keys wherever the provider offers them.

- One Cloudflare Worker: Hono routes, React 19 pages rendered on the server and hydrated in the
  browser, D1, Cron Triggers.
- UI: [coss ui](https://coss.com/ui) on Base UI, shadcn Charts on Recharts, Lucide icons, Geist Sans and
  Geist Mono, Tailwind CSS 4, Motion where it helps.
- Forms are plain POST forms (Post/Redirect/Get), so every action works before the page hydrates.
  Scripts are same-origin only (CSP `script-src 'self'`). The one exception is opt-in: with Turnstile
  on, the log-in and sign-up pages also load Cloudflare's challenge script.
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
- **Updating an existing install:** deploys apply pending D1 migrations first. Some migrations rebuild
  a table (`0003` does, to accept new provider ids), so before updating, note a restore point with
  `npx wrangler d1 time-travel info hoomuch`. If anything looks wrong afterwards,
  `npx wrangler d1 time-travel restore hoomuch --timestamp=<that time>` puts the database back.
  Revenue from merchant-of-record providers now leaves out sales tax. Lemon Squeezy history synced
  before this change and older than about 30 days keeps tax in; delete and re-add the connection to
  recount it.
- **Plan:** password hashing (PBKDF2, 100k iterations) and syncs can exceed the Free plan's 10 ms CPU
  limit. Workers Paid is recommended for production.

### Protecting a public instance

If you keep sign-ups open, hoomuch defends itself in layers. Each one is cheap, and each catches what
the one before lets through:

- **Request limits** (`RL_REQUESTS`, `RL_AUTH` under `ratelimits` in `wrangler.jsonc`): Cloudflare's
  Rate Limiting binding turns a flood away per network (IPv6 by /64) before the Worker touches D1.
  Every request counts against 300 a minute; log-in and sign-up submissions against 10 a minute.
  `namespace_id` only has to be unique within your Cloudflare account.
- **Exact limits in D1**, each counted before the password hash: log-in attempts per email and
  network, per account, and per network across all emails (30 every 15 minutes, which stops
  credential stuffing), plus 5 new accounts per network a day.
- **No throwaway inboxes.** Sign-ups from the
  [disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains)
  list (CC0) are refused, subdomains included. The list is vendored, so there's no lookup at runtime;
  `npm run domains:update` refreshes it.
- **A honeypot field** on both forms that people never see, so bots that fill every input give
  themselves away. It needs no JavaScript.
- **Turnstile**, if you set both keys. Create a widget in the Cloudflare dashboard (Managed mode,
  your hostname), put its site key in `TURNSTILE_SITE_KEY` under `vars` in `wrangler.jsonc`, and run
  `wrangler secret put TURNSTILE_SECRET_KEY`. Log in and sign up then need JavaScript, and only those
  two pages allow `challenges.cloudflare.com` in their CSP. For local testing, Cloudflare's test pair
  (`1x00000000000000000000AA` / `1x0000000000000000000000000000000AA`) passes on any host.

Cloudflare blocks network-level DDoS on its own. Its WAF and Bot Fight Mode only see traffic on your
own domain, though, not on `*.workers.dev`. For a public instance, add a custom domain and set
`"workers_dev": false` in `wrangler.jsonc`, so nobody can go around them.

## Connecting providers

| Provider | Key | Permissions |
|----------|-----|-------------|
| Stripe | Restricted key `rk_live_…` | Read: Subscriptions, Prices, Coupons, Balance |
| Paddle | API key `pdl_live_apikey_…` (expires; one year at most) | Read: Subscriptions, Transactions, Adjustments, Metrics; Discounts optional |
| Lemon Squeezy | API key (can't be scoped, so it has full access) | — |
| Polar | Organization access token `polar_oat_…` | `metrics:read`, `subscriptions:read`, `orders:read`, `refunds:read` |
| RevenueCat | v2 secret key `sk_…` + Project ID | `charts_metrics:overview:read`; `charts_metrics:charts:read` is optional and enables daily revenue history |
| Chargebee | Read-only API key + site name | Read-only key (All, or Restricted with transactional data) |
| Dodo Payments | API key `dodo_live_…` | Read: Subscriptions, Balances |
| Gumroad | Access token from your own Gumroad application (can't be scoped, so it has full access) | — |
| Adapty | Secret API key `secret_live_…` (can't be scoped) | — |
| Superwall | Organization API key + Organization ID | `charts:read`; `data:read` is optional and enables daily revenue, refunds and trials |

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
| `npm run domains:update` | Refreshes the disposable-email blocklist (`src/lib/disposable-domains.ts`) from upstream |

## Layout

```
src/
  index.tsx          middleware (CSP, CSRF, session, flash) and cron entry
  lib/               crypto, auth, money, time, flash, rate limits, bot checks
  db/queries.ts      users, sessions, connections
  providers/         adapter contract, registry, one adapter per provider, Demo
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

Each provider's section in [SPEC.md](SPEC.md) §6 lists what was checked against its docs and what wasn't.
The ones you'd notice:

- Stripe: customer-level discounts aren't applied, and with Stripe Tax, tax-inclusive prices stay
  tax-inclusive in MRR.
- Lemon Squeezy: refunds issued more than about 30 days after purchase are missed, and several partial
  refunds on one order show as one refund.
- Paddle and Polar: MRR is the provider's own figure, in one currency (Paddle: your balance currency;
  Polar: USD). Polar's version pin (`2026-10`) has to be updated before April 2027.
- RevenueCat, Adapty, Superwall: daily history is in USD only, revenue is the stores' gross (tax and
  store fees included), and test mode can't be detected.
- Dodo Payments: revenue comes from the balance ledger, so it's daily totals with no transaction list.
- Gumroad: MRR is an estimate. The API doesn't say what each subscriber pays, so hoomuch prices them
  at their latest charge, or the tier's list price when it can't find one. Refunds land on the sale's
  day, because Gumroad doesn't date them.
- Creem isn't supported yet: its API has no date filter on transactions and no dated refunds (SPEC §6.9).
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
