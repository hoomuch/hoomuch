<!--
The title becomes the commit message when this is squash-merged, so write it as a Conventional
Commit, e.g. `feat(dashboard): show what happened on any day in a calendar`. CONTRIBUTING.md,
"Commit messages", has the types and scopes.
-->

## What and why

<!-- What changes, and why. Link the issue: `Closes #123`. -->

## How you checked it

<!-- Tests you added, and what you looked at by hand (demo data, a test-mode key). -->

## Checklist

- [ ] `npm run check` passes
- [ ] Nothing creates, updates or deletes anything on the provider side
- [ ] No end-customer personal data is stored, returned or logged, and no secrets reach logs or errors
- [ ] Money stays in integer minor units with an ISO 4217 code
- [ ] Schema changes are a new migration; no applied migration was edited
- [ ] README, SPEC §6 or CONTRIBUTING are updated where behaviour changed
- [ ] Self-hosters have to do something by hand when they upgrade: the title has `!` and the
      description says what to do (`BREAKING CHANGE:`)
