# Secrets runbook (maintainers)

The mock services (`@crvouga/mockingbird-service-*`, the only published packages) are released
automatically on every green push to `main` (see [RELEASING.md](RELEASING.md)) and publish with
**npm Trusted Publishing (OIDC)**.

OIDC can only publish to packages that already exist on npm and trust this repo. For brand-new
packages the release job loads `NPM_TOKEN` from Vault `secret/personal/prd`:

- **Automatic release.** A granular npm token with read+write on the `@crvouga` scope lives in
  Vault. CI loads it through GitHub OIDC, creates missing packages, then runs `npm trust github`
  so later releases use OIDC. A scheduled run every six hours retries interrupted releases.
- **Local fallback.** From any checkout: `bun run release:seed` (`-- --dry-run` to preview). It runs
  `npm login` if needed, uses npm@11 when yours is too old for `npm trust`, builds `origin/main` in a
  temporary worktree and runs `release:publish --local` there. Publishes without provenance with your npm login, pushes the tags and GitHub Releases, attaches
  the Trusted Publishers and deprecates every package no longer published — i.e. it reconciles
  npm with `origin/main`.

All credentials live in the shared self-hosted Vault / OpenBao at `https://vault.chrisvouga.dev`,
KV v2 `secret/personal/<config>` (`dev` locally, `prd` for production and CI; same key names in
both, one field per env var). This repo follows the shared-infra contract:
https://raw.githubusercontent.com/crvouga/workspace/main/llms.txt

- **Turborepo remote cache** (`TURBO_API`, `TURBO_TOKEN`, `TURBO_TEAM`, `TURBO_CACHE`) —
  locally every root turbo script (`bun run build|test|check|…`) goes through
  [`scripts/vault-run.ts`](../scripts/vault-run.ts), which wraps it in `vault run` using
  [`.vault.yaml`](../.vault.yaml). In CI, [`.github/actions/setup`](../.github/actions/setup/action.yml)
  loads them with Vault GitHub OIDC (role `github-actions`, policy `ci-read`) — no stored token.
- **Live parity sandbox keys** (`MOCKINGBIRD_*`) — in `personal/prd`; `bun run parity*` runs under
  `vault run --config prd`. CI publish never reads them; the Verify workflow reads the Junction key.

Local setup, once per machine (from a `crvouga/workspace` checkout; needs the `vault`/`bao` CLI + `jq`):

```bash
packages/vault-service/scripts/install-cli.sh   # ~/.local/bin/vault wrapper (adds `vault run`)
bun run vault:login                             # userpass login as crvouga
```

Without the wrapper, turbo scripts still run, with only the local cache.

Inventory:

- [`.vault.yaml`](../.vault.yaml) — Vault address / mount / project / config (no secrets)
- [`.env.example`](../.env.example) — every env var name this repo reads (no values)
- [`secrets.manifest.yaml`](../secrets.manifest.yaml) — secrets (Turbo cache, `NPM_TOKEN`, parity keys) + OIDC checklist

## Quick commands

```bash
# Log in to self-hosted Vault/OpenBao as crvouga; prompts for password
bun run vault:login

# Verify the remote cache: second run with unchanged inputs → "cache hit, replaying logs"
bun run build && bun run build

# Full report: which packages exist on npm, Trusted Publishing links, Actions secrets
bun run secrets:doctor

# Missing NPM_TOKEN? Prompt securely, store it in Vault, then run and watch current CI
bun run release:bootstrap

# What the next release would publish
bun run release:plan
bun run release:publish -- --dry-run
```

## Trusted Publisher settings

Set automatically by the release job when it has npm account credentials. Manual equivalent, per
package at `https://www.npmjs.com/package/<name>/access`:

- Organization/user: `crvouga`
- Repository: `mockingbird`
- Workflow filename: `ci.yml`
- Environment: (empty)

Docs: https://docs.npmjs.com/trusted-publishers

## Parity credentials (Vault)

Field name = env var name, in `secret/personal/prd` (API path `secret/data/personal/prd`):

| Provider | Fields / env vars |
| --- | --- |
| Stripe | `MOCKINGBIRD_STRIPE_SECRET_KEY`, `MOCKINGBIRD_STRIPE_PUBLISHABLE_KEY` |
| Junction | `MOCKINGBIRD_JUNCTION_API_KEY` |
| GeneByGene | `MOCKINGBIRD_GENEBYGENE_CLIENT_ID`, `MOCKINGBIRD_GENEBYGENE_CLIENT_SECRET` |

`bun run parity*` and `bun run verify:junction` inject them with `vault run --config prd`. The
[Verify workflow](../.github/workflows/verify.yml) (daily, not a required check) reads only
`MOCKINGBIRD_JUNCTION_API_KEY`, through the same GitHub OIDC role as the Turborepo cache. Scripts run directly fall back to
`@crvouga/mockingbird-openbao`, which reads `secret/data/personal/prd` (override per provider with
`MOCKINGBIRD_OPENBAO_PATH_<PROVIDER>`) using `VAULT_TOKEN` / `BAO_TOKEN` / `~/.vault-token`, or a
GitHub OIDC JWT (`MOCKINGBIRD_OPENBAO_JWT`, role `github-actions`).

```bash
bun run vault:login
bun run parity:stripe
bun run parity:junction
bun run parity:genebygene
```

## What exists where

| Credential | Where | Required |
| --- | --- | --- |
| npm Trusted Publisher (OIDC) | each package on npm | **Yes** (CI publish; attached automatically) |
| `GITHUB_TOKEN` | Built into GitHub Actions | Automatic |
| `TURBO_*` (remote cache) | Vault `personal/{dev,prd}` → `vault run` locally, OIDC in CI | Yes (else no remote cache) |
| `GH_PAT` | Optional Vault `personal/prd` | No (local only) |
| Provider sandbox keys | Vault `personal/prd` | For live parity only |
| `NPM_TOKEN` | Vault `personal/prd` → CI through GitHub OIDC | Creates new packages and manages Trusted Publishers |
