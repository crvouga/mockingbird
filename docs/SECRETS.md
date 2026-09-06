# Secrets runbook (maintainers)

`@crvouga/mockingbird` (and the granular `@crvouga/mockingbird-*` packages) publish with
**npm Trusted Publishing (OIDC)** — not Automation tokens.

Live parity sandbox credentials live in the self-hosted Vault / OpenBao at
`https://vault.chrisvouga.dev` under the flat KV v2 secret `secret/data/secret`
(shown as `secret/secret` in the UI). CI publish never reads those keys; only
`bun run parity*` does (via `@crvouga/mockingbird-openbao`).

Inventory:

- [`.vault.yaml`](../.vault.yaml) — Vault address / mount / project / config
- [`secrets.manifest.yaml`](../secrets.manifest.yaml) — optional local secrets + OIDC checklist

## Quick commands

```bash
# Full report + Trusted Publishing setup links (never prints secret values)
bun run secrets:doctor

# If the umbrella package is not on npm yet (one-time, uses `npm login` — not a token)
bun run npm:seed -- --dry-run
bun run npm:seed -- --yes

# Validate optional Vault keys
bun run secrets:check
```

## One-time: seed + Trusted Publishing

1. Log in interactively: `npm login --auth-type=web`
2. `bun run build && bun run npm:seed -- --yes` — publishes `@crvouga/mockingbird@0.1.0` without provenance
3. For **each** public package on npm, open Trusted Publisher and add:
   - Organization/user: `crvouga`
   - Repository: `mockingbird`
   - Workflow filename: `ci.yml`
4. Confirm the release job has `permissions.id-token: write` in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)

Docs: https://docs.npmjs.com/trusted-publishers

After that, green pushes to `main` run `bun run release:publish`, which publishes every public
workspace package whose version is not already on npm (idempotent).

## Parity credentials (Vault)

| Provider | Vault path (KV v2 under `secret`) | Fields | Env overrides |
| --- | --- | --- | --- |
| Stripe | `secret/data/secret` | `secret_key` | `MOCKINGBIRD_STRIPE_SECRET_KEY` |
| Junction | `secret/data/secret` | `api_key` | `MOCKINGBIRD_JUNCTION_API_KEY` |
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
| npm Trusted Publisher (OIDC) | each package on npm | **Yes** (CI publish) |
| `GITHUB_TOKEN` | Built into GitHub Actions | Automatic |
| `GH_PAT` | Optional Vault `personal/prd/github` | No (local only) |
| Provider sandbox keys | Vault `secret/data/secret` | For live parity only |
| `NPM_TOKEN` | — | **Not used** |
