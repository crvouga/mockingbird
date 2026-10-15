# Secrets runbook

Where every credential lives, who needs it, and how to run live parity without ever holding a sandbox key: GitHub Actions repo secrets are the only secret store.

There is no self-hosted secret store and no remote build cache to log in to. A fresh clone needs
nothing but Bun:

```bash
bun run setup   # install, build, create .env.local from .env.example
bun test        # no secrets
bun run check   # every CI gate, no secrets
```

Secrets are only involved in two places, and both run on GitHub with the repo's own
Actions secrets. Anyone with **write access** to `crvouga/mockingbird` can use them without
seeing a value (GitHub never returns a secret's value, to anyone):

| Workflow | Secrets it reads | How to run it |
| --- | --- | --- |
| [Parity](../.github/workflows/parity.yml) | the `<SERVICE>_*` keys its live-parity step maps | `bun run parity:remote -- <service…>`, `-- --all` or `-- --tier=warm`; by [tier](TESTING.md#parity-tiers) also on each PR that changes a hot service ([Advisory](../.github/workflows/advisory.yml), non-blocking, not for forks) and weekly for warm services |
| [Verify](../.github/workflows/verify.yml) | `JUNCTION_API_KEY` | daily, or `gh workflow run verify.yml` |

## Live parity

Each service's `scripts/parity.ts` loads its sandbox credentials from the environment through
[`@crvouga/mockingbird-credentials`](../packages/auth/credentials). The env var names start
with the service's name (`STRIPE_SECRET_KEY`, `JUNCTION_API_KEY`), and the GitHub Actions secret
has the same name.

**On GitHub (no keys needed).** Push your branch, then:

```bash
bun run parity:remote -- stripe            # one or more services
bun run parity:remote -- --all             # every service with a parity script
bun run parity:remote -- --tier=warm       # every service in a tier
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

This runs the unified npm, publisher, and secrets checks. Use `-- --verbose` to list every
service's GitHub and optional local credential readiness; values are never printed. The full
`bun run health` command also checks docs deployment, images, workflows, and infrastructure
configuration ([details](DEVELOPMENT.md#infrastructure-health)).

### Adding or rotating a sandbox key

`bun run secrets` is a small CLI over the repo secrets. It sends values to `gh secret set` over
stdin, so they never appear in output or on a command line:

```bash
bun run secrets                            # status: set / missing per service, on GitHub and locally
bun run secrets fill stripe                # prompt (hidden) for each missing key; Enter skips one
bun run secrets fill                       # ...for every service
bun run secrets set STRIPE_SECRET_KEY          # prompt for one value (rotate)
bun run secrets set STRIPE_SECRET_KEY --from-env   # take it from .env.local
bun run secrets rm STRIPE_OLD_KEY --yes
```

To upload everything you have set in `.env.local` at once:

```bash
bun run secrets push -- --dry-run          # which secrets would be set (= secrets:push)
bun run secrets push -- --yes
```

A service's secrets are the fields its parity script loads plus the names `.env.example` lists
under the service's heading; `secrets:doctor` and `secrets:push` read both. The Parity workflow needs one line per secret in the `env:` of its
live-parity step (`STRIPE_X: ${{ secrets.STRIPE_X }}`). It maps each secret by name
because GitHub holds a run that dumps the whole `secrets` context as "may be malicious" until
someone approves it by hand.

## Resolving issues on GitHub

`bun github:resolve-issues` runs the [Resolve issues](../.github/workflows/resolve-issues.yml)
workflow as **you**, with credentials bounded to that run. No repo secret is involved. The workflow
starts one Claude Code agent per `agent-reported` issue. Each agent opens a draft PR, runs
[`/resolve-issues <n>`](../.agents/commands/resolve-issues.md), and then runs `/pr-ready` until the
PR is green and ready to merge. When a decision needs a human, the agent comments on the issue
instead. It never merges.

```bash
bun github:resolve-issues setup           # once, by the repo owner (below)
bun github:resolve-issues                 # the queue: up to 3 (--max=<k>, at most 10) unassigned parity, bug, then feature issues
bun github:resolve-issues 190 191         # these issues (a new-service issue runs only when named)
bun github:resolve-issues --dry-run 190   # hand over and check the credentials, then stop
```

### Safeguards

- **You confirm each run.** The command shows the issues, model and ref, and asks before it
  creates anything (`--yes` skips the prompt). You then approve the run's GitHub token in the
  browser.
- **The GitHub token is minted per run and reaches this repo only.** GitHub has no API that
  creates a personal access token. So the command mints a GitHub App user access token with the
  device flow, from the repo's own app:
  - The app is installed on this repository alone.
  - It has only Contents, Issues, Pull requests and Actions write, and Checks and Statuses read.
    It has no Workflows, Administration, Secrets or Variables permission.
  - The token expires within 8 hours, and commits and PRs made with it are yours, so they
    trigger CI.

  The command refuses a token that reaches more, or that does not expire, and the job checks it
  again before using it (`scripts/github-app-token.ts`). So an agent misled by an issue's text
  cannot reach your other repositories, change a workflow file, or push to `main` (the ruleset
  also blocks that). Your `gh` login is used only on your machine, to dispatch the run and pass
  the credentials over.
- **Claude access is subscription-only.** `CLAUDE_CODE_OAUTH_TOKEN` comes from your `.env.local`
  (`claude setup-token`). The job unsets `ANTHROPIC_API_KEY`, and Claude Code keeps its
  credentials out of the agent's shell commands (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`).
- **Credentials are never workflow inputs.** The repository is public, and inputs are neither
  masked nor secret. Instead, each job generates a key pair and uploads only its public key. The
  command encrypts the credentials to that key, bound to the run and the issue, and passes the
  ciphertext through a secret gist. It deletes the gist as soon as every job has read it; keep the
  command running until it says so, which takes a minute or two. The job masks both tokens,
  refuses anything that is not a one-line token, deletes its private key, and redacts both tokens
  from the agent's report. A re-run job cannot get credentials, so dispatch again instead.
- **Runs are bounded.** A run takes at most 10 issues, and each job stops after 3 hours. The job
  holds no vendor sandbox keys: to check a report against the oracle, the agent dispatches the
  Parity workflow (`bun run parity:remote`).

To cut a run's token off before it expires, revoke the app's authorization at
https://github.com/settings/apps/authorizations.

### One-time setup (repo owner)

```bash
bun github:resolve-issues setup
```

1. It opens a localhost page that registers the app on GitHub from a manifest. The app is
   private, has no webhook, and has only the permissions above. The command keeps only the app's
   public client id and slug, in `.github/resolve-issues-app.json`. The app's private key and
   client secret are dropped unread, so nothing can ever act as the app itself.
2. In the app's settings, tick **Enable Device Flow**, and keep **Expire user authorization
   tokens** on. Install the app on **Only select repositories** and pick this repository. The
   command prints both links.
3. Run `bun github:resolve-issues setup` again. It mints a token and checks all of the above.
   Then commit `.github/resolve-issues-app.json`.

## Releasing

The emulator services (`@crvouga/mockingbird-service-*`, the only published packages) are released
automatically on every green push to `main` (see [RELEASING.md](RELEASING.md)) and publish with
**npm Trusted Publishing (OIDC)**, which needs no stored credential.

OIDC can only publish to packages that already exist on npm and trust this repo. For brand-new
packages, `bun run release:seed` (`-- --dry-run` to preview) runs `npm login` if
  needed, builds `origin/main` in a kept worktree and runs `release:publish --local` there:
  it publishes with your npm login, pushes the tags and GitHub Releases, attaches the Trusted
  Publishers and deprecates every package no longer published. Bulk publisher changes are spaced
  at npm's recommended interval; any unresolved package makes the seed fail with its exact name,
  and a rerun resumes safely. CI never receives or falls back to a long-lived npm token. A
  scheduled run every six hours retries interrupted OIDC releases.

For existing packages rejected by CI with `ENEEDAUTH`, run
`bun run release:seed -- --trust-only`. This repairs and verifies their Trusted Publisher
settings using your interactive npm login, without a build or a new package publication.

```bash
bun run release:plan                       # what the next release would publish
bun run release:publish -- --dry-run
```

### Trusted Publisher settings

Set by the local seed after the first publish. Manual equivalent, per package at
`https://www.npmjs.com/package/<name>/access`:

- Organization/user: `crvouga`
- Repository: `mockingbird`
- Workflow filename: `ci.yml`
- Environment: (empty)
- Allowed actions: npm publish

`bun run health -- trusted-publisher` checks every public workspace package, including one
that has not been published yet. It lists packages that still need configuration with links
to `/access`. The separate `npm` check also verifies retirement of former packages. A publisher
that can only stage, or that is pinned to an environment, is included: the Release
workflow calls `npm publish` and sets no environment. It uses the `npm login` session
and reports unreadable settings as unknown. Add `--interactive` to open npm's security-key
prompt, which `npm login` itself does not complete. If
that page offers to skip two-factor for a few minutes, turn it on so one approval
covers every package.

Docs: https://docs.npmjs.com/trusted-publishers

## Build cache

Turborepo uses its local cache (`.turbo/cache`) on your machine. In CI,
[`.github/actions/setup`](../.github/actions/setup/action.yml) keeps that same directory in the
GitHub Actions cache, one entry per CI job, warmed by every push to `main`, so pull requests replay
what `main` already built and tested. No token, no server.

## What exists where

| Credential | Where | Needed for |
| --- | --- | --- |
| npm Trusted Publisher (OIDC) | each package on npm | CI publish (attached by the local seed) |
| `GITHUB_TOKEN` | built into GitHub Actions | automatic |
| `<SERVICE>_*` sandbox keys | repo secrets (+ optionally your `.env.local`) | live parity only |
| `CLAUDE_CODE_OAUTH_TOKEN` | your `.env.local` (never a repo secret) | `bun github:resolve-issues`: your Claude subscription |
| Resolve issues GitHub App | its public client id in `.github/resolve-issues-app.json`; no private key or client secret is kept | `bun github:resolve-issues`: mints a token per run for this repo only (`setup` creates it) |
| `GITGUARDIAN_API_KEY` | your `.env.local` | optional: `pr:ready guardian ignore` |

Inventory: [`secrets.manifest.yaml`](../secrets.manifest.yaml) (non-parity secrets and the
Trusted Publishing checklist) and [`.env.example`](../.env.example) (every local name).
