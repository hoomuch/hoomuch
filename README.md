<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/mascot/perched-dark.png">
    <img src="public/mascot/perched.png" alt="The hoomuch owl" width="96" height="96">
  </picture>
</p>

<h1 align="center">hoomuch</h1>

<p align="center">
  All your subscription revenue under one roof. Self-hosted, read-only, open source.
</p>

<p align="center">
  <a href="https://github.com/hoomuch/hoomuch/actions/workflows/ci.yml"><img src="https://github.com/hoomuch/hoomuch/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License: AGPL-3.0"></a>
</p>

<p align="center">
  <a href="#deploy-to-cloudflare">Deploy</a> ·
  <a href="#connecting-providers">Providers</a> ·
  <a href="#known-limitations">Known limitations</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="SPEC.md">Spec</a>
</p>

hoomuch connects to the billing providers you already use and puts the numbers on one dashboard:
total MRR and ARR, active subscriptions, trials and revenue, converted into one currency and broken
down by connection.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/dashboard-dark.png">
  <img src=".github/assets/dashboard-light.png" alt="The hoomuch dashboard with demo data: MRR of $5,168 with a 30-day chart, active subscriptions, trials, revenue, and a breakdown by connection">
</picture>

- **Twelve providers.** Stripe, Paddle, Lemon Squeezy, Polar, RevenueCat, Chargebee, Dodo Payments,
  Gumroad, Adapty, Superwall, App Store Connect and Google Play.
- **Read-only.** hoomuch never writes to a provider, and asks for read-only keys wherever the provider
  offers them.
- **Your keys stay on your account.** It runs on your own Cloudflare account, and provider keys are
  encrypted at rest (AES-256-GCM).
- **No customer personal data.** It keeps amounts, currencies, timestamps, IDs and plan names, never
  your customers' emails, names or addresses.
- **Try it without a key.** After signing up, **Try demo data** fills the dashboard with a sample
  business.
- **Show your MRR, verified.** On instances that turn it on, publish a product's MRR on a public page
  with a badge for your site or README (see [Public pages](#public-pages)).

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hoomuch/hoomuch)

### One click

Click **Deploy to Cloudflare** above. Cloudflare copies this repo into your GitHub or GitLab account,
creates the D1 database and the sync queue, and asks for `ENCRYPTION_KEY` (generate one with
`openssl rand -base64 32`). Every deploy applies pending D1 migrations first, and every push to your
copy redeploys it.

### By hand

```bash
npx wrangler login
npx wrangler d1 create hoomuch       # copy the printed database_id into wrangler.jsonc
openssl rand -base64 32 | npx wrangler secret put ENCRYPTION_KEY
npm run deploy                       # applies D1 migrations, then deploys
```

The first deploy also creates the `hoomuch-sync` queue that every sync runs on.

To pull new releases without conflicts, keep your changes out of `wrangler.jsonc`: copy
`wrangler.local.example.jsonc` to `wrangler.local.jsonc` (gitignored), put your `database_id`, your
domain and any vars you change in it, and deploy with `npm run deploy:local`. It applies your file
over `wrangler.jsonc` and then does what `npm run deploy` does.

Queues are on the Free plan too, with 10,000 operations a day. Each sync is about three
operations, so that's roughly 3,300 syncs a day: around 130 connections at the default hourly
interval.

### After deploying

- **Back up `ENCRYPTION_KEY`.** If it's lost, every stored provider key becomes unreadable and each
  connection has to be re-keyed. Never rotate it in place.
- **Close sign-ups.** Create your account, then set `"ALLOW_SIGNUP": "false"` in `wrangler.jsonc` and
  deploy again (with the button, commit that change to your copy of the repo).
- **Use Workers Paid for production.** Password hashing (PBKDF2, 100k iterations) and syncs can exceed
  the Free plan's 10 ms CPU limit.

## Configuration

| Name | Where | Default | What it does |
|------|-------|---------|--------------|
| `ENCRYPTION_KEY` | Secret (`wrangler secret put`) | none, required | 32 random bytes, base64. Encrypts provider keys at rest. |
| `ALLOW_SIGNUP` | `vars` in `wrangler.jsonc` | `"true"` | Set to `"false"` once your own account exists, so nobody else can sign up. |
| `SYNC_INTERVAL_MINUTES` | `vars` in `wrangler.jsonc` | `"60"` | How often each connection syncs, rounded up to a multiple of the 30-minute cron. |
| `TURNSTILE_SITE_KEY` | `vars` in `wrangler.jsonc` | `""` (off) | Optional. A [Turnstile](https://developers.cloudflare.com/turnstile/) widget's site key. With the secret below, log in and sign up require the Turnstile check. |
| `TURNSTILE_SECRET_KEY` | Secret (`wrangler secret put`) | none | Optional. The same widget's secret key. |
| `RESEND_API_KEY` | Secret (`wrangler secret put`) | none (off) | Optional. A [Resend](https://resend.com) API key with sending access. When set, sign-up mails a confirmation link and new accounts can't use hoomuch until it's clicked (see below). |
| `MAIL_FROM` | `vars` in `wrangler.jsonc` | `""` | Sender of that email, on a domain verified in Resend, e.g. `hoomuch <hello@example.com>`. Needed once `RESEND_API_KEY` is set. |
| `RL_REQUESTS`, `RL_AUTH` | `ratelimits` in `wrangler.jsonc` | 300 and 10 a minute | Per-network request limits (see below). `namespace_id` must be unique in your Cloudflare account. |
| `RL_WEBHOOKS` | `ratelimits` in `wrangler.jsonc` | 30 a minute | Webhook calls per connection (see [Real-time updates](#real-time-updates)). Webhooks skip the per-network limits, because a provider sends every customer's calls from the same addresses. Its `namespace_id` must be unique too. |
| `PUBLIC_PAGES` | `vars` in `wrangler.jsonc` | `""` (off) | Optional. `"true"` lets owners publish a product's verified revenue at `/p/<slug>`, with a badge, a profile at `/u/<handle>` and a listing on `/explore` (see [Public pages](#public-pages)). |
| `MEDIA` | `r2_buckets` in `wrangler.local.jsonc` | none (off) | Optional, with `PUBLIC_PAGES`. An [R2](https://developers.cloudflare.com/r2/) bucket for founders' photos and products' logos (see [Public pages](#public-pages)). Turn R2 on in your Cloudflare account, then add `"r2_buckets": [{ "binding": "MEDIA", "bucket_name": "hoomuch-media" }]`; `wrangler deploy` creates the bucket if it's missing. Without it, pages show initials. |
| `LEGAL_NAME`, `LEGAL_EMAIL` | `vars` in `wrangler.jsonc` | `""` (off) | Optional. With both set, `/privacy` and `/terms` serve hoomuch.com's privacy policy and terms of service, naming this operator and address, and every footer and the sign-up form link them. They're written for an individual operator in Türkiye under the KVKK: if that isn't you, leave these empty and publish your own. |
| `SYNC_QUEUE` | `queues` in `wrangler.jsonc` | queue `hoomuch-sync` | Required. Every sync runs in this queue's consumer, one connection at a time per invocation (up to 10 at once). `wrangler deploy` creates the queue if it's missing. |

The cron schedule itself is `triggers.crons` in `wrangler.jsonc`. Each tick puts the connections that
are due on the queue, up to 1,000 of them, enough for about 2,000 connections on the hourly interval.
Past that, each connection syncs less often, the most overdue first, and the tick's `cron_sync` log
line is a warning with `"stop":"cap"`.

### Protecting a public instance

If you keep sign-ups open, hoomuch defends itself in layers. Each one is cheap, and each catches what
the one before lets through:

- **Request limits** (`RL_REQUESTS`, `RL_AUTH`): Cloudflare's Rate Limiting binding turns a flood
  away per network (IPv6 by /64) before the Worker touches D1. Every request counts against 300 a
  minute; log-in and sign-up submissions against 10 a minute.
- **Exact limits in D1**, each counted before the password hash: log-in attempts per email and
  network, per account, and per network across all emails (30 every 15 minutes, which stops
  credential stuffing), plus 5 new accounts per network a day.
- **No throwaway inboxes.** Sign-ups from the
  [disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains)
  list (CC0) are refused, subdomains included. The list is vendored, so there's no lookup at runtime;
  `npm run domains:update` refreshes it.
- **A honeypot field** on both forms that people never see, so bots that fill every input give
  themselves away. It needs no JavaScript.
- **Email verification**, if you set `RESEND_API_KEY` and `MAIL_FROM`. Without it, anyone can sign
  up with an address they don't own. With it, a new account is held at a "check your inbox" page
  until the person opens the link mailed to them. The link works once and expires after 24 hours,
  and "Send the link again" is limited to 3 every 15 minutes and 10 a day per account. An account
  nobody confirms is removed once all its links have expired, so the address is free for its real
  owner. Accounts from before this feature (migration `0004`) count as confirmed; ones created later
  while mail was off are asked to confirm the next time they're used. Verify your sending domain in
  Resend and turn its click tracking off, so links reach people unchanged.
- **Turnstile**, if you set both keys. Create a widget in the Cloudflare dashboard (Managed mode,
  your hostname), put the site key in `vars` and `wrangler secret put TURNSTILE_SECRET_KEY`. Log in and
  sign up then need JavaScript, and only those two pages allow `challenges.cloudflare.com` in their
  CSP. For local testing, Cloudflare's test pair (`1x00000000000000000000AA` /
  `1x0000000000000000000000000000000AA`) passes on any host.

Cloudflare blocks network-level DDoS on its own. Its WAF and Bot Fight Mode only see traffic on your
own domain, though, not on `*.workers.dev`. For a public instance, add a custom domain and set
`"workers_dev": false` in `wrangler.jsonc`, so nobody can go around them.

## Connecting providers

| Provider | Key | Permissions |
|----------|-----|-------------|
| Stripe | Restricted key `rk_live_…` | Read: Subscriptions, Prices, Balance; Coupons is optional and takes discounts off MRR; Products is optional and splits MRR by product |
| Paddle | API key `pdl_live_apikey_…` (expires; one year at most) | Read: Subscriptions, Transactions, Adjustments, Metrics; Discounts optional |
| Lemon Squeezy | API key (can't be scoped, so it has full access) | — |
| Polar | Organization access token `polar_oat_…` | `metrics:read`, `subscriptions:read`, `orders:read`, `refunds:read` |
| RevenueCat | v2 secret key `sk_…` + Project ID | `charts_metrics:overview:read`; `charts_metrics:charts:read` is optional and enables daily revenue history |
| Chargebee | Read-only API key + site name | Read-only key (All, or Restricted with transactional data) |
| Dodo Payments | API key `dodo_live_…` | Read: Subscriptions, Balances |
| Gumroad | Access token from your own Gumroad application (can't be scoped, so it has full access) | — |
| Adapty | Secret API key `secret_live_…` (can't be scoped) | — |
| Superwall | Organization API key + Organization ID | `charts:read`; `data:read` is optional and enables daily revenue, refunds and trials |
| App Store Connect | Team API key (`.p8` file) + Issuer ID, Key ID and vendor number | Sales role (Finance or Admin also work, but can do more). Individual keys can't read sales reports |
| Google Play | Service account JSON key + the reports bucket's Cloud Storage URI | Play Console: View app information and download bulk reports; View financial data. The Google Play Android Developer API turned on in the service account's project |

Keys are checked live before they're saved. The first sync backfills 90 days of revenue. After that,
each connection syncs every `SYNC_INTERVAL_MINUTES` (an hour by default), and **Sync now** runs one
straight away.

### Real-time updates

Stripe, Paddle, Lemon Squeezy, Polar, Chargebee, Dodo Payments and Gumroad can tell hoomuch when
something changes, so a new subscription or refund shows up about a minute later instead of at the
next scheduled sync. On the connection's page, under **Real-time updates**, click **Turn on**, then
add the URL it shows as a webhook in the provider's dashboard. The page lists where to paste it and
which events to pick.

- **A call is only a signal.** hoomuch never reads what a webhook sends, which can include your
  customers' details, and doesn't check the provider's signature. It syncs that connection through
  its read-only key, as a scheduled sync would. A burst of events becomes one sync, and webhook syncs
  of one connection start at least 5 minutes apart.
- **Keep the URL private.** It carries a secret token, and anyone who has it can make hoomuch sync
  that connection (at that same rate at most). **New URL** replaces it, and the old one stops working.
- **Not offered** for App Store Connect and Google Play (their reports arrive a day later), Adapty
  (one webhook URL per environment, which apps already use), and RevenueCat and Superwall (their
  charts refresh on their own schedule).

### Public pages

With `PUBLIC_PAGES` set to `"true"`, a **Share** page appears next to Transactions. There an owner
groups one or more connections into a product (Stripe for the web app and RevenueCat for the iOS app,
say) and publishes it:

- **`/p/<slug>`** shows how much the product makes, in US dollars: total revenue (all the history
  hoomuch holds, from its first day), MRR with active subscriptions, revenue over the last 30 days,
  and subscriptions, with the founder under the name. Below that, a chart of revenue or MRR over 7
  days to all time, and the providers the figures come from, with **Visit** and buttons to post it on
  X, LinkedIn or Bluesky at the top. Anyone sees revenue over the
  last 30 days; every other chart needs a free hoomuch account, and choosing one asks the visitor to
  sign up and brings them back to it. The locked history isn't in the page: it comes from
  `/api/p/<slug>/history`, for signed-in accounts only. They're the dashboard's figures
  for those connections, worked out again after every sync. The owner can't type them in; the name,
  description, website and founder details are theirs, and the page says so.
- **`/p/<slug>.md`** is the same page as Markdown, for AI assistants.
- **`/badge/<slug>.svg`** is a badge ("Verified MRR | $12,340") for a site or README. It turns grey
  when the figures haven't been confirmed by a sync for 72 hours.
- **`/u/<handle>`** is the founder's profile: their public products added up, and each one's
  revenue, MRR and total. Publishing a product needs a founder profile, and the profile is public
  while at least one of their products is.
- **Photos and logos**, with the `MEDIA` bucket: a founder can upload a photo, and a product gets its
  website's icon when it's saved with a website, or a logo its owner uploads. They're served from
  your own domain at `/media/<key>` (so the pages' `img-src 'self'` still holds), checked by their
  bytes (PNG, JPEG, WebP or GIF; ICO from a website; never SVG), at most 2 MB and 4096 pixels a side,
  and stored without their metadata (a phone photo's location and camera details are taken out). A
  browser with JavaScript crops and scales an upload to 400 pixels before sending it. An account can
  make 20 changes in 15 minutes. They're deleted with the product or the account.

- **`/explore`** lists the published products whose founders list them (a box on the publish form,
  ticked by default), by MRR, growth or newest, with a search that runs as you type, a provider
  filter, a Founders tab, and an "Add your product" button for visitors. A product
  shows there once it has MRR, a sync in the last 72 hours and 30 days of revenue history. Once six
  products qualify, the landing page shows the six growing fastest. `/sitemap.xml` lists them all
  for search engines: submit it in Google Search Console and Bing Webmaster Tools.

To take a product off Explore (spam, a name that breaks your rules), set `hidden_at`; its page and
badge stay public, and its owner sees that it was taken off:

```bash
npx wrangler d1 execute DB --remote --command \
  "UPDATE public_products SET hidden_at = unixepoch() * 1000 WHERE slug = 'the-slug'"
```

Total revenue starts where hoomuch's history does: the first sync reads 90 days back, so it isn't
the business's lifetime revenue. Demo data and test-mode keys never count. Nothing is public until the
owner ticks a confirmation and publishes, and unpublishing takes the page and badge down; a browser that loaded one in the last few
minutes may still show its copy. Public pages and badges are rendered without the visitor's session,
so the same response can be cached for everyone.

## Updating

Each [release](https://github.com/hoomuch/hoomuch/releases) lists what changed and anything you have
to do by hand. To hear about new ones, choose **Watch → Custom → Releases** on this repository.

Pull the latest changes from this repository into your copy and deploy (with the button, pushing to
your copy redeploys it). Every deploy applies pending D1 migrations first. Some migrations rebuild a
table (`0003` does, to accept new provider ids), so note a restore point before you update:

```bash
npx wrangler d1 time-travel info hoomuch
```

If anything looks wrong afterwards, put the database back:

```bash
npx wrangler d1 time-travel restore hoomuch --timestamp=<that time>
```

Changes that affect data you've already synced:

- **Sales tax.** Revenue from merchant-of-record providers now leaves out sales tax. Lemon Squeezy
  history synced before this change and older than about 30 days keeps tax in; delete and re-add the
  connection to recount it.
- **Currency units.** Amounts follow ISO 4217 minor units, so HUF, IDR, COP and PKR count in
  hundredths. They used to show 100× too large; rows already stored now read correctly without a
  resync. Stripe sends ISK, UGX and MGA in its own units, which are now converted on sync. Rows synced
  before that read 100× off (ISK and UGX too large, MGA too small) until the connection is removed and
  added again.
- **v1.1: time zones and exchange rates.** Days now follow your time zone, set once from where you
  sign in (change it in **Settings**). Revenue from transaction-based providers is regrouped
  automatically. Past revenue now converts at its own day's rate; the first cron after the upgrade
  fetches about 200 days of rates.
- **Stripe MRR by product.** The dashboard's **By product** card can now split Stripe MRR by product.
  It needs **Products: Read** on the Stripe key: edit the restricted key in Stripe (⋯ → **Edit key**)
  and the split appears after the next sync. Without it, Stripe syncs as before.

## Known limitations

Each provider's section in [SPEC.md](SPEC.md) §6 lists what was checked against its docs and what
wasn't. The ones you'd notice:

- **Stripe:** customer-level discounts aren't applied, and with Stripe Tax, tax-inclusive prices stay
  tax-inclusive in MRR. Payments carry no product name (reaching one needs read access to invoices and
  charges, which hold customer details), so Stripe is split by product on MRR only, not on revenue.
- **Lemon Squeezy:** refunds issued more than about 30 days after purchase are missed, and several
  partial refunds on one order show as one refund. Its docs don't say which units it uses for
  currencies without two decimals; hoomuch assumes ISO 4217.
- **Paddle and Polar:** MRR is the provider's own figure, in one currency (Paddle: your balance
  currency; Polar: USD). Polar's version pin (`2026-10`) has to be updated before April 2027. A
  test fails from mid-January 2027 until it is.
- **RevenueCat, Adapty, Superwall:** daily history is in USD only, revenue is the stores' gross (tax
  and store fees included), and test mode can't be detected.
- **Dodo Payments:** revenue comes from the balance ledger, so it's daily totals with no transaction
  list.
- **App Store Connect:** numbers come from Apple's Sales and Trends reports, so they run a day behind
  (Apple publishes each Pacific Time day the next morning). MRR counts standard-price subscriptions;
  subscribers on a paid introductory or promotional price count as active but not in MRR, because the
  report doesn't say what they pay. Revenue is the customer price, tax included, before Apple's
  commission, in each buyer's currency.
- **Google Play:** Google has no revenue API, so hoomuch reads the reports Play Console exports. MRR
  is Google's active-subscription count priced at each base plan's current price in that country, a
  few days behind; subscribers in a free trial, on an offer or on an older price are counted at that
  price, and trials show as unknown. Revenue comes per order from the estimated sales report (tax
  included, before Google's fee). A newly invited service account can take up to a day to see the
  reports.
- **Gumroad:** MRR is an estimate. The API doesn't say what each subscriber pays, so hoomuch prices
  them at their latest charge, or the tier's list price when it can't find one. Refunds land on the
  sale's day, because Gumroad doesn't date them.
- **Creem** isn't supported yet: its API has no date filter on transactions and no dated refunds
  (SPEC §6.9).
- **Days** run midnight to midnight in your time zone. It's picked up from where you first sign in,
  and you can change it in **Settings**. RevenueCat, Dodo Payments, Adapty and Superwall report daily
  totals in UTC, and App Store Connect in Pacific Time; those totals keep the provider's days (the
  dashboard says so). MRR snapshots taken before v1.1 stay on UTC days.
- **Exchange rates:** revenue converts at the exchange rate of its own day and
  MRR at the latest, both from [Frankfurter](https://frankfurter.dev): the ECB's reference rate where
  it publishes one, other central banks' otherwise. Rates before an instance's first sync reach back
  about 200 days; a currency that first shows up later converts its earlier days at its oldest rate.

## How it's built

- One Cloudflare Worker: Hono routes, React 19 pages rendered on the server and hydrated in the
  browser, D1, Cron Triggers.
- UI: [coss ui](https://coss.com/ui) on Base UI, shadcn Charts on Recharts, Lucide icons, Geist Sans
  and Geist Mono, Tailwind CSS 4, Motion where it helps.
- Forms are plain POST forms (Post/Redirect/Get), so every action works before the page hydrates.
  Scripts are same-origin only (CSP `script-src 'self'`). The one exception is opt-in: with Turnstile
  on, the log-in and sign-up pages also load Cloudflare's challenge script.
- Metric definitions and the full product and technical spec are in [SPEC.md](SPEC.md) (in Turkish).

## Development

Requirements: Node 24.14 or later (`.nvmrc` has the version CI and Cloudflare's builds use).

```bash
npm install
cp .dev.vars.example .dev.vars          # then set ENCRYPTION_KEY, e.g. openssl rand -base64 32
npm run db:migrate:local
npm run dev                             # http://localhost:8787
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the rest: running a sync by hand, the npm scripts, the project
layout, the ground rules for pull requests and how to add a provider.

## Security

Please don't open a public issue for a vulnerability. Report it privately through GitHub's
**Security → Report a vulnerability** form on this repository. [SECURITY.md](SECURITY.md) says
what's in scope and what happens next.

## Contributing

Bug reports, fixes and new provider adapters are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md); new providers and new dependencies begin with an issue. Everyone
taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## License

hoomuch is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only).

You can use, self-host and modify it freely. If you run a **modified** version as a service other
people use, the AGPL requires you to offer those users your modified source code. The footer of every
page links to the source; point it at your fork (`SOURCE_URL` in `src/views/layout.tsx`).
