# Contributing to hoomuch

Thanks for helping. Bug reports, fixes and new provider adapters are all welcome.

## Before you start

- **Small fixes:** open a pull request directly.
- **New features, new providers or new npm dependencies:** open an issue first so we can agree on the
  approach before you write the code. The project keeps its dependency list very short on purpose.
  The issue forms ask what's needed; a provider request asks what its API offers.
- **Security issues:** don't open a public issue. Report them privately through GitHub's
  **Security → Report a vulnerability** form on this repository, as [SECURITY.md](SECURITY.md)
  describes.

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Local setup

Requirements: Node 24.14 or later. The tests run D1 on `node:sqlite` and check money formatting
against Intl's ICU data, and older releases, Node 22 included, fail some of them. `.nvmrc` has the
version CI and Cloudflare's builds use, so `nvm use` or `fnm use` picks it.

```bash
npm install
cp .dev.vars.example .dev.vars          # then set ENCRYPTION_KEY, e.g. openssl rand -base64 32
npm run db:migrate:local
npm run dev                             # http://localhost:8787
```

Sign up locally, then click **Try demo data** to get a filled dashboard without a real API key.

The cron sync doesn't fire on its own in local dev. To run it by hand:

```bash
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*/30+*+*+*+*"
```

The cron only queues the connections that are due; `wrangler dev` runs the sync queue locally, so
the syncs follow a moment later in the same terminal.

Before opening a pull request, run:

```bash
npm run check                           # typecheck + tests + build
```

It must pass. CI runs the same check on every pull request, on Node 24.14 and on the `.nvmrc`
version, and checks that the pull request title is a Conventional Commit (see *Commit messages*).

### Scripts

| Script | What it does |
|--------|--------------|
| `npm run dev` | `wrangler dev`, with D1 and the sync queue local. Rebuilds the CSS and the browser bundle on every reload |
| `npm run check` | Typecheck, tests and build |
| `npm test` | Vitest: adapters, sync engine and read models run on an in-memory D1 |
| `npm run build` | `css` + `js` |
| `npm run css` | Builds `public/app.css` with the Tailwind CLI |
| `npm run js` | Builds the browser bundle into `public/client/` with esbuild (code-split per page) |
| `npm run deploy` | Applies remote D1 migrations, then `wrangler deploy` |
| `npm run db:migrate:local` / `:remote` | Applies the D1 migrations |
| `npm run cf-typegen` | Regenerates `worker-configuration.d.ts` |
| `npm run domains:update` | Refreshes the disposable-email blocklist (`src/lib/disposable-domains.ts`) from upstream |

### Project layout

```text
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
scripts/             client build, the commit-msg check, the domain list refresh
test/                Vitest suites and API fixtures
```

## Commit messages

Commit messages follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).
Pull request titles follow the same format, because a squash merge turns the title into the commit
message.

```text
<type>[(<scope>)][!]: <description>

[body]

[footers]
```

**Type.** One of these:

| Type       | Use it for                                                                       |
| ---------- | -------------------------------------------------------------------------------- |
| `feat`     | something new people can see or do: a provider, a page, a metric, a setting      |
| `fix`      | a bug fix: wrong numbers, a broken page, a sync that fails                       |
| `perf`     | faster or lighter, with no change in behaviour                                   |
| `refactor` | a code change that neither fixes a bug nor adds a feature                        |
| `test`     | tests and fixtures only                                                          |
| `docs`     | README, SPEC, CONTRIBUTING and code comments only                                |
| `style`    | formatting only (whitespace, import order). A visual change to the UI is `feat` or `fix` |
| `build`    | the client and CSS builds, `wrangler.jsonc`, npm dependencies                    |
| `ci`       | CI configuration                                                                 |
| `chore`    | anything else that leaves `src` and `test` alone, such as repo tooling           |
| `revert`   | undoing an earlier commit                                                        |

**Scope** (optional). A lowercase noun naming the area: a provider id (`stripe`, `paddle`,
`lemonsqueezy`, `revenuecat`, …) or one of `sync`, `dashboard`, `connections`, `transactions`,
`settings`, `auth`, `db`, `ui`, `landing`, `security`, `deps`. Leave it out when a change cuts across
the app.

**Description.** In the imperative (`add`, not `added` or `adds`), starting lowercase unless it starts
with a name, with no full stop at the end. The whole first line fits in 72 characters.

**Body** (optional). One blank line after the first line. Say why the change was made, and anything
a reviewer can't see in the diff.

**Footers** (optional). One blank line after the body, one `Token: value` per line, such as
`Refs: #123` or `Co-authored-by: Name <email>`.

**Breaking changes.** A change is breaking when someone running their own instance has to do
something by hand when they upgrade: a new or renamed binding or secret, a migration that needs a
manual step, a removed route or setting. Put `!` before the colon, and say what to do in a
`BREAKING CHANGE:` footer, in capitals.

Examples, the first three rewritten from this repository's history:

```text
feat(dashboard): show what happened on any day in a calendar
```

```text
build(deps): update recharts and wrangler to their latest releases
```

```text
build: write the client bundle in place instead of deleting public/client

Several `wrangler dev` servers can build at once. When one deleted
public/client, another kept answering 404 for /client/entry.js until it
was restarted.
```

```text
feat(sync)!: read the sync schedule from wrangler.jsonc

BREAKING CHANGE: move your schedule into triggers.crons in wrangler.jsonc
before you deploy.
```

**Checked on every commit.** `npm install` points git at `.githooks/` (the `prepare` script), and
`.githooks/commit-msg` turns down a message that breaks these rules and says why. Merge commits,
git's own `Revert "…"` messages and `fixup!`, `squash!` and `amend!` commits pass through. If you
cloned before the hook existed, run `npm install` once. The *PR title* check in CI applies the same
rules to the pull request title.

## Ground rules

These keep the product what it is. Pull requests that break them will be asked to change.

- **Read-only.** hoomuch only ever reads from a provider. No endpoint that creates, updates or
  deletes anything on the provider side.
- **No end-customer personal data.** Never store, return or log customer emails, names or addresses.
  Keep amounts, currencies, timestamps, external IDs and product or plan names only.
- **Never log secrets.** No API keys, tokens, passwords or encrypted blobs in logs or error messages.
- **Money is integer minor units** (cents, kuruş) with an uppercase ISO 4217 code. No floats.
  Zero-decimal currencies (JPY, KRW, …) must come out right.
- **Forms work before hydration, scripts stay same-origin.** Pages are React, rendered on the server and
  hydrated in the browser, but every action is a plain POST form (Post/Redirect/Get). No inline
  `<script>` (the CSP is `script-src 'self'`; the page payload is a JSON data block). The only
  third-party script is Cloudflare Turnstile, and only when an instance turns it on: then
  `/login` and `/signup` alone allow `challenges.cloudflare.com`, and need JavaScript. Inline styles are
  allowed for Base UI, Recharts and Motion; for colours of your own, use Tailwind classes.
- **Render the same thing on the server and in the browser.** No `Date.now()`, `Math.random()` or
  `window` checks while rendering; use `useNow()` (views/page-root.tsx) for the request's clock, and
  keep page props plain JSON.
- **UI comes from coss ui.** Add components with `npx shadcn@latest add @coss/<name>` (they land in
  `src/components/ui`), and wrap them in `src/views/components/ui.tsx` only to add hoomuch's rules.
- **The dashboard reads only from D1.** Provider APIs are called from the sync engine, never while
  rendering a page.

## Adding a provider

The adapter contract is in [`src/providers/types.ts`](src/providers/types.ts). Adapters are pure:
they take an injected `fetch` and clock (`ctx.fetch`, `ctx.now`), never touch D1 or `env`, and throw
`ProviderError` for every expected failure. Use the Stripe, Lemon Squeezy and RevenueCat adapters as
references.

1. **Id.** Add the id to `ProviderId` and `PROVIDER_IDS` in `src/providers/types.ts`.
2. **Migration.** None needed for the id: migration `0003` dropped the `CHECK` on
   `connections.provider`, and `PROVIDER_IDS` is the guard now. If the adapter needs a new column,
   add a new numbered migration. Never edit an applied migration.
3. **Adapter.** Write `src/providers/<id>.ts` implementing `ProviderAdapter`:
   - `verify`: a live, read-only check of the key, at most about 3 requests, with a clear error
     message and the form `field` it belongs to.
   - `fetchSnapshot`: MRR (normalised to monthly, trials excluded), active subscriptions and trials.
     When a figure is incomplete or estimated (a missing optional permission, items without a price),
     say so in `warnings`: one short sentence each, exported as a constant, with no customer data or
     provider text. They show on the dashboard and the connection page until a sync stops reporting them.
   - `fetchRevenue`: charges and refunds since `req.since`. Check `hasBudget(ctx)` before each page:
     it turns false when the request budget runs out or the sync's deadline passes. Then return a
     `nextCursor`, so the next sync can resume.
   - `fetchSnapshotHistory` (optional): past days' snapshots, oldest first, if the provider has an MRR
     series. It runs once, on a connection's first successful sync, so a new dashboard starts with a
     trend. The demo adapter is the reference.
4. **Registry.** Add its `ProviderMeta` to `PROVIDERS`, and the adapter to `ADAPTERS`, in
   `src/providers/registry.ts`. Mark key fields `secret: true` so they're stored encrypted. Spell out
   the `dotClass` as a literal Tailwind class such as `bg-[#635BFF]` so the CSS build picks it up.
   List the exact read permissions the key needs.
5. **Tests.** Put real response shapes under `test/fixtures/<id>/` (taken from the provider's API docs,
   with any personal data removed) and write `test/providers/<id>.test.ts`. Cover MRR maths, paging and
   cursors, error mapping (401, 403, 404, 429, 5xx), and use `expectNoSecretsInLogs`.
6. **Docs.** Add the provider to the table in [README.md](README.md), its MRR and revenue rules to
   SPEC §6, and any edge cases to *Known limitations*.

[SPEC.md](SPEC.md) is written in Turkish. It's the source of truth for metric definitions; a
translator or an LLM handles it fine, and questions in issues are welcome.

## License

hoomuch is licensed under [AGPL-3.0-only](LICENSE). By submitting a contribution you agree that it
is licensed under the same terms.
