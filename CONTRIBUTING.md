# Contributing to hoomuch

Thanks for helping. Bug reports, fixes and new provider adapters are all welcome.

## Before you start

- **Small fixes:** open a pull request directly.
- **New features, new providers or new npm dependencies:** open an issue first so we can agree on the
  approach before you write the code. The project keeps its dependency list very short on purpose.
- **Security issues:** don't open a public issue. Report them privately through GitHub's
  **Security → Report a vulnerability** form on this repository.

## Local setup

Requirements: Node 20+.

```bash
npm install
cp .dev.vars.example .dev.vars          # then set ENCRYPTION_KEY, e.g. openssl rand -base64 32
npm run db:migrate:local
npm run dev                             # http://localhost:8787
```

Sign up locally, then click **Try demo data** to get a filled dashboard without a real API key.

Before opening a pull request, run:

```bash
npm run check                           # typecheck + tests + CSS build
```

It must pass.

## Ground rules

These keep the product what it is. Pull requests that break them will be asked to change.

- **Read-only.** hoomuch only ever reads from a provider. No endpoint that creates, updates or
  deletes anything on the provider side.
- **No end-customer personal data.** Never store, return or log customer emails, names or addresses.
  Keep amounts, currencies, timestamps, external IDs and product or plan names only.
- **Never log secrets.** No API keys, tokens, passwords or encrypted blobs in logs or error messages.
- **Money is integer minor units** (cents, kuruş) with an uppercase ISO 4217 code. No floats.
  Zero-decimal currencies (JPY, KRW, …) must come out right.
- **Nearly zero client JavaScript and a strict CSP.** No inline `<script>` or `style` attributes. Use
  Tailwind classes, or SVG `fill` / `stroke` attributes for colours. Forms use Post/Redirect/Get.
- **The dashboard reads only from D1.** Provider APIs are called from the sync engine, never while
  rendering a page.

## Adding a provider

The adapter contract is in [`src/providers/types.ts`](src/providers/types.ts). Adapters are pure:
they take an injected `fetch` and clock (`ctx.fetch`, `ctx.now`), never touch D1 or `env`, and throw
`ProviderError` for every expected failure. Use the Stripe, Lemon Squeezy and RevenueCat adapters as
references.

1. **Id.** Add the id to `ProviderId` and `PROVIDER_IDS` in `src/providers/types.ts`.
2. **Migration.** `connections.provider` has a `CHECK` constraint listing every provider id
   (`migrations/0001_init.sql`). Add a new numbered migration that allows the new id. SQLite can't
   change a `CHECK` in place, so the table has to be rebuilt. Never edit an applied migration.
3. **Adapter.** Write `src/providers/<id>.ts` implementing `ProviderAdapter`:
   - `verify`: a live, read-only check of the key, at most about 3 requests, with a clear error
     message and the form `field` it belongs to.
   - `fetchSnapshot`: MRR (normalised to monthly, trials excluded), active subscriptions and trials.
   - `fetchRevenue`: charges and refunds since `req.since`. Stop when `ctx.pageBudget` runs out and
     return a `nextCursor`, so the next sync can resume.
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
