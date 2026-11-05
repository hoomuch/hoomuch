# hoomuch

The contributor guide is the source of truth for setup, ground rules and commit messages:

@CONTRIBUTING.md

## Commits

Every commit message and pull request title follows Conventional Commits 1.0.0, as set out in
*Commit messages* above: `<type>[(<scope>)][!]: <description>`, first line within 72 characters,
imperative, no full stop. `.githooks/commit-msg` rejects anything else, so write the message to pass
it rather than bypassing it with `--no-verify`.
