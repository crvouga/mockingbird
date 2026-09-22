# AGENTS.md

Shared infra (Vault, Turborepo remote cache, R2 object store, hosting):
https://raw.githubusercontent.com/crvouga/workspace/main/llms.txt

Always re-fetch that URL rather than trusting a cached copy: it is generated from
`crvouga/workspace` and tracks its `main`, so ports, hostnames and the fleet list stay current.

How this repo uses it (details in [docs/SECRETS.md](docs/SECRETS.md)):

- **Vault** — `.vault.yaml` points at `secret/personal/dev`. Never print, invent, or commit secret
  values; if one is missing, tell the human the key + path and stop.
- **Turborepo remote cache** — root turbo scripts (`bun run build|test|check|…`) run through
  `scripts/vault-run.ts`, i.e. `vault run`, which injects `TURBO_*`. CI loads them in
  `.github/actions/setup` via Vault GitHub OIDC; never add a `VAULT_TOKEN` or `TURBO_TOKEN`
  GitHub secret. If the cache is down, report it — don't disable caching.
- **Live parity** — `bun run parity*` runs under `vault run --config prd` (sandbox keys live in
  `secret/personal/prd`).
- **Hosting** — the docs site ships as the fleet service `mockingbird-docs`: `sites/docs/Dockerfile`
  (build context = repo root) is built and pushed to GHCR by `.github/workflows/publish.yml` on every
  push to `main`, then deployed by `crvouga/workspace`. Never deploy from Railway or push images by
  hand; the `services.yaml` entry lives in `crvouga/workspace`.

Agent commands (`/ci`, `/pr-merge`, `/parity-loop`, `/resolve-issues`) live in `.agents/commands/`;
see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#agent-commands).

Agents in other projects report parity mismatches, missing features and bugs, and request new
services, as GitHub issues labelled `agent-reported` ([docs/REPORTING_ISSUES.md](docs/REPORTING_ISSUES.md),
templates in `.github/ISSUE_TEMPLATE/`, labels in `.github/labels.json`); `/resolve-issues` works
that queue.

`README.md` and `llms.txt` are generated: edit their sources (`sites/docs/src/lib/content.ts`, each
service's `package.json`, `docs/*.md`), then run `bun run readme:sync` and `bun run llms:sync`.
`bun run check` fails when either is stale.
