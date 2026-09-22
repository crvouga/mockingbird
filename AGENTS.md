# AGENTS.md

Shared infra (Vault, Turborepo remote cache, R2 object store):
https://raw.githubusercontent.com/crvouga/workspace/main/INTEGRATING.md

How this repo uses it (details in [docs/SECRETS.md](docs/SECRETS.md)):

- **Vault** — `.vault.yaml` points at `secret/personal/dev`. Never print, invent, or commit secret
  values; if one is missing, tell the human the key + path and stop.
- **Turborepo remote cache** — root turbo scripts (`bun run build|test|check|…`) run through
  `scripts/vault-run.ts`, i.e. `vault run`, which injects `TURBO_*`. CI loads them in
  `.github/actions/setup` via Vault GitHub OIDC; never add a `VAULT_TOKEN` or `TURBO_TOKEN`
  GitHub secret. If the cache is down, report it — don't disable caching.
- **Live parity** — `bun run parity*` runs under `vault run --config prd` (sandbox keys live in
  `secret/personal/prd`).

Agent commands (`/ci`, `/pr-merge`, `/parity-loop`) live in `.agents/commands/`; see
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#agent-commands).

`README.md` and `llms.txt` are generated: edit their sources (`sites/docs/src/lib/content.ts`, each
service's `package.json`, `docs/*.md`), then run `bun run readme:sync` and `bun run llms:sync`.
`bun run check` fails when either is stale.
