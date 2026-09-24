# AGENTS.md

Onboarding is `bun run setup`, then `bun test` / `bun run check`. None of it needs a secret, an
account, or any self-hosted service.

- **Secrets** — GitHub Actions repo secrets are the only store ([docs/SECRETS.md](docs/SECRETS.md)).
  Never print, invent, or commit secret values; if one is missing, tell the human the key name and
  stop. Local values go in `.env.local` (gitignored, loaded by Bun).
- **Live parity** — `bun run parity:remote -- <service…>` runs it on GitHub with the repo's
  `MOCKINGBIRD_*` secrets (needs only `gh auth login`); `bun run parity:service -- <service…>` runs
  it locally with keys from `.env.local`. `bun run secrets:doctor` shows which services have keys.
- **Build cache** — turbo's local cache; CI keeps it in the GitHub Actions cache
  (`.github/actions/setup`). There is no remote cache or token.
- **Hosting** — the docs site ships as the fleet service `mockingbird-docs`: `sites/docs/Dockerfile`
  (build context = repo root) is built and pushed to GHCR by `.github/workflows/publish.yml` on every
  push to `main`, then deployed by `crvouga/workspace`. Never deploy from Railway or push images by
  hand; the `services.yaml` entry lives in `crvouga/workspace`. Hosting contract:
  https://raw.githubusercontent.com/crvouga/workspace/main/llms.txt (re-fetch it, don't trust a
  cached copy).

Agent commands (`/ci`, `/pr-merge`, `/parity-loop`, `/resolve-issues`) live in `.agents/commands/`;
see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#agent-commands).

Agents in other projects report parity mismatches, missing features and bugs, and request new
services, as GitHub issues labelled `agent-reported` ([docs/REPORTING_ISSUES.md](docs/REPORTING_ISSUES.md),
templates in `.github/ISSUE_TEMPLATE/`, labels in `.github/labels.json`); `/resolve-issues` works
that queue.

`README.md` and `llms.txt` are generated: edit their sources (`sites/docs/src/lib/content.ts`, each
service's `package.json`, `docs/*.md`), then run `bun run readme:sync` and `bun run llms:sync`.
`bun run check` fails when either is stale.
