# Secrets runbook (maintainers)

`@crvouga/mockingbird` and the granular `@crvouga/mockingbird-*` packages are released
automatically on every green push to `main` (see the root README → Releasing) and publish with
**npm Trusted Publishing (OIDC)**.

OIDC can only publish to packages that already exist on npm and trust this repo. For brand-new
packages the release job needs one of:

- **`NPM_TOKEN` Actions secret (recommended, fully automated).** A granular npm token with
  read+write on the `@crvouga` scope. The release job uses it only to create new packages
  (and as a fallback if an OIDC publish is rejected), then runs `npm trust github` so every later
  release of that package goes through OIDC. It also deprecates the archived legacy packages.
- **Local seed.** From any checkout: `bun run release:seed` (`-- --dry-run` to preview). It runs
  `npm login` if needed, uses npm@11 when yours is too old for `npm trust`, builds `origin/main` in a
  temporary worktree and runs `release:publish --local` there. Publishes without provenance with your npm login, pushes the tags and GitHub Releases, attaches
  the Trusted Publishers and deprecates the legacy packages.

Live parity sandbox credentials live in the self-hosted Vault / OpenBao at
`https://vault.chrisvouga.dev` under the flat KV v2 secret `secret/data/secret`
(shown as `secret/secret` in the UI). CI publish never reads those keys; only
`bun run parity*` does (via `@crvouga/mockingbird-openbao`).

Inventory:

- [`.vault.yaml`](../.vault.yaml) — Vault address / mount / project / config
- [`secrets.manifest.yaml`](../secrets.manifest.yaml) — optional secrets (incl. `NPM_TOKEN`) + OIDC checklist

## Quick commands

```bash
# Log in to self-hosted Vault/OpenBao as crvouga; prompts for password
bun run vault:login

# Full report: which packages exist on npm, Trusted Publishing links, Actions secrets
bun run secrets:doctor

# Push NPM_TOKEN from Vault (personal/prd) to the NPM_TOKEN Actions secret
bun run secrets:sync

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

| Provider | Vault path (KV v2 under `secret`) | Fields | Env overrides |
| --- | --- | --- | --- |
| Stripe | `secret/data/secret` | `MOCKINGBIRD_STRIPE_SECRET_KEY`, `MOCKINGBIRD_STRIPE_PUBLISHABLE_KEY` | `MOCKINGBIRD_STRIPE_SECRET_KEY` |
| Junction | `secret/data/secret` | `MOCKINGBIRD_JUNCTION_API_KEY` | `MOCKINGBIRD_JUNCTION_API_KEY` |
| GeneByGene | `secret/data/secret` | `client_id`, `client_secret` | `MOCKINGBIRD_GENEBYGENE_CLIENT_ID`, `MOCKINGBIRD_GENEBYGENE_CLIENT_SECRET` |

Default OpenBao address: `https://vault.chrisvouga.dev` (`MOCKINGBIRD_OPENBAO_ADDR` / `VAULT_ADDR`).
Auth: `VAULT_TOKEN` / `BAO_TOKEN` / `~/.vault-token`, or JWT (`MOCKINGBIRD_OPENBAO_JWT`).

```bash
export VAULT_ADDR=https://vault.chrisvouga.dev
vault login
bun run parity:stripe
bun run parity:junction
bun run parity:genebygene
```

## What exists where

| Credential | Where | Required |
| --- | --- | --- |
| npm Trusted Publisher (OIDC) | each package on npm | **Yes** (CI publish; attached automatically) |
| `GITHUB_TOKEN` | Built into GitHub Actions | Automatic |
| `GH_PAT` | Optional Vault `personal/prd/github` | No (local only) |
| Provider sandbox keys | Vault `secret/data/secret` | For live parity only |
| `NPM_TOKEN` | Vault `personal/prd` → Actions secret | Only to create new packages (else `bun run release:seed`) |
