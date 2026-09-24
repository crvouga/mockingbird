# Secrets runbook

Where every credential lives, who needs it, and how to run live parity without ever holding a sandbox key: GitHub Actions repo secrets are the only secret store.

There is no self-hosted secret store and no remote build cache to log in to. A fresh clone needs
nothing but Bun:

```bash
bun run setup   # install, build, create .env.local from .env.example
bun test        # no secrets
bun run check   # every CI gate, no secrets
```

Secrets are only involved in three places, and all three run on GitHub with the repo's own
Actions secrets. Anyone with **write access** to `crvouga/mockingbird` can use them without
seeing a value (GitHub never returns a secret's value, to anyone):

| Workflow | Secrets it reads | How to run it |
| --- | --- | --- |
| [Parity](../.github/workflows/parity.yml) | the `MOCKINGBIRD_*` keys its live-parity step maps | `bun run parity:remote -- <service…>` or `-- --all` |
| [Verify](../.github/workflows/verify.yml) | `MOCKINGBIRD_JUNCTION_API_KEY` | daily, or `gh workflow run verify.yml` |
| [Release](../.github/workflows/ci.yml) | `NPM_TOKEN` (new packages only) | automatic on merge to `main` |

## Live parity

Each service's `scripts/parity.ts` loads its sandbox credentials from the environment through
[`@crvouga/mockingbird-credentials`](../packages/auth/credentials). The env var names all start
with `MOCKINGBIRD_`, and the GitHub Actions secret has the same name.

**On GitHub (no keys needed).** Push your branch, then:

```bash
bun run parity:remote -- stripe            # one or more services
bun run parity:remote -- --all             # every service with a parity script
```

This dispatches the Parity workflow on your branch, which passes the sandbox keys its live-parity
step maps to the run, and streams the log to your terminal. Needs `gh auth login`. The workflow
also uploads each service's `corpus/` directory as the `parity-corpus` artifact
(`gh run download <run-id> -n parity-corpus`), so a live recording can be committed.

**Locally (your own keys).** Put sandbox keys in `.env.local` (gitignored, loaded by Bun
automatically; `.env.example` lists every name, grouped by service), then:

```bash
bun run parity:service -- stripe twilio
bun run parity:stripe                      # the turbo shortcuts work too
```

A parity script exits 2 when its credentials are missing, and `parity:service` reports that as
"no credentials", never as a pass.

**Which services are configured?**

```bash
bun run secrets:doctor
```

This prints, per service, whether every key it needs is set as a repo secret (runnable with
`parity:remote`) and in your `.env.local`. It never prints values.

### Adding or rotating a sandbox key

`bun run secrets` is a small CLI over the repo secrets. It sends values to `gh secret set` over
stdin, so they never appear in output or on a command line:

```bash
bun run secrets                            # status: set / missing per service, on GitHub and locally
bun run secrets fill stripe                # prompt (hidden) for each missing key; Enter skips one
bun run secrets fill                       # ...for every service
bun run secrets set MOCKINGBIRD_STRIPE_SECRET_KEY          # prompt for one value (rotate)
bun run secrets set MOCKINGBIRD_STRIPE_SECRET_KEY --from-env   # take it from .env.local
bun run secrets rm MOCKINGBIRD_OLD_KEY --yes
```

To upload everything you have set in `.env.local` at once:

```bash
bun run secrets push -- --dry-run          # which secrets would be set (= secrets:push)
bun run secrets push -- --yes
```

Once a service's parity script loads a `MOCKINGBIRD_*` field, `secrets:doctor`, `secrets:push` and
`.env.example` pick it up. The Parity workflow needs one line per secret in the `env:` of its
live-parity step (`MOCKINGBIRD_X: ${{ secrets.MOCKINGBIRD_X }}`). It maps each secret by name
because GitHub holds a run that dumps the whole `secrets` context as "may be malicious" until
someone approves it by hand.

## Releasing

The mock services (`@crvouga/mockingbird-service-*`, the only published packages) are released
automatically on every green push to `main` (see [RELEASING.md](RELEASING.md)) and publish with
**npm Trusted Publishing (OIDC)**, which needs no stored credential.

OIDC can only publish to packages that already exist on npm and trust this repo. For brand-new
packages the release job uses the `NPM_TOKEN` repo secret:

- **Automatic release.** A granular npm token with read+write on the `@crvouga` scope is stored as
  `NPM_TOKEN`. CI creates missing packages, then runs `npm trust github` so later releases use
  OIDC. A scheduled run every six hours retries interrupted releases.
- **Setting the token.** `bun run release:bootstrap` prompts for it without echo, validates it with
  npm, stores it with `gh secret set`, then runs and watches CI on `main`. `-- --replace` rotates it.
- **Local fallback.** `bun run release:seed` (`-- --dry-run` to preview) runs `npm login` if
  needed, builds `origin/main` in a temporary worktree and runs `release:publish --local` there:
  it publishes with your npm login, pushes the tags and GitHub Releases, attaches the Trusted
  Publishers and deprecates every package no longer published.

```bash
bun run release:plan                       # what the next release would publish
bun run release:publish -- --dry-run
```

### Trusted Publisher settings

Set automatically by the release job when it has npm account credentials. Manual equivalent, per
package at `https://www.npmjs.com/package/<name>/access`:

- Organization/user: `crvouga`
- Repository: `mockingbird`
- Workflow filename: `ci.yml`
- Environment: (empty)

Docs: https://docs.npmjs.com/trusted-publishers

## Build cache

Turborepo uses its local cache (`.turbo/cache`) on your machine. In CI,
[`.github/actions/setup`](../.github/actions/setup/action.yml) keeps that same directory in the
GitHub Actions cache, so pull requests replay what `main` already built. No token, no server.

## What exists where

| Credential | Where | Needed for |
| --- | --- | --- |
| npm Trusted Publisher (OIDC) | each package on npm | CI publish (attached automatically) |
| `GITHUB_TOKEN` | built into GitHub Actions | automatic |
| `NPM_TOKEN` | repo secret | creating new packages, deprecations |
| `MOCKINGBIRD_*` sandbox keys | repo secrets (+ optionally your `.env.local`) | live parity only |
| `GITGUARDIAN_API_KEY` | your `.env.local` | optional: `pr:ready guardian ignore` |

Inventory: [`secrets.manifest.yaml`](../secrets.manifest.yaml) (non-parity secrets and the
Trusted Publishing checklist) and [`.env.example`](../.env.example) (every local name).
