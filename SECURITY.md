# Security policy

hoomuch holds API keys to your billing providers, so security reports come first.

## Supported versions

hoomuch doesn't publish releases yet. Fixes land on `main`, so the supported version is the latest
commit on `main`. Self-hosters get a fix by updating their copy and deploying (README, *Updating*).

## Reporting a vulnerability

Please don't report a vulnerability in a public issue, discussion or pull request.

Report it privately through GitHub instead: **Security → Report a vulnerability** on this repository,
or [open a draft advisory](https://github.com/tahabozdemir/hoomuch/security/advisories/new) directly.

It helps to include:

- what an attacker can do, and what they need first (an account on the instance, a provider key,
  nothing at all);
- steps to reproduce it, or a proof of concept;
- the commit you tested.

Use test-mode provider keys. Never send real API keys, an `ENCRYPTION_KEY` or anyone's customer data.

## What happens next

- You get a reply within 7 days, saying whether the report is confirmed.
- A confirmed issue is fixed on `main`, and a GitHub security advisory says who's affected and what
  self-hosters should do.
- The advisory credits you, unless you'd rather not be named.

Please give us the time to ship a fix before you publish anything.

## Scope

In scope is the code in this repository, deployed as the README describes: the Worker and its
routes and pages, the sync engine, the provider adapters, how stored keys are encrypted, and the
migrations. These matter most:

- reading or decrypting another account's provider keys or data on a shared instance;
- making hoomuch write to a provider, which it must never do;
- API keys, secrets or customers' personal data leaking into logs, error messages or pages;
- getting around the CSRF checks, the session handling or the Content Security Policy.

Out of scope:

- flaws in Cloudflare or in a provider's own API (report those to the vendor);
- an instance set up against the README's advice, such as sign-ups left open on a public instance;
- scanner output with no impact you can show.
