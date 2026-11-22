# Developing Mockingbird

Working on this repo: requirements, how the packages are layered, and the quality gates every change passes.

## Requirements

- **Node.js ≥ 22** or **Bun ≥ 1.2** (ESM only).
- npm is required for the package-integrity gates (`bunx publint`, `bunx attw`); Bun runs the rest.

```bash
git clone https://github.com/crvouga/mockingbird.git && cd mockingbird
bun run setup   # install, build every package, create .env.local from .env.example
bun test
```

That is the whole onboarding: no secrets, no accounts, nothing self-hosted. `bun run setup` is idempotent and uses [workspaces](https://bun.sh/docs/install/workspaces) + [Turborepo](https://turbo.build/repo/docs/overview). Live parity against the real sandboxes needs keys, but they are GitHub Actions secrets: with write access to the repo, `bun run parity:remote -- <service>` runs it on GitHub without you ever holding one ([docs/SECRETS.md](SECRETS.md)). A git hook lints commit messages on the spot — see [Quality gates](#quality-gates).

## Packages

**Naming (hard rule):** every package is `@crvouga/mockingbird-<kebab-case>`; the short names below drop that prefix. `bun run check:boundaries` fails CI on any other name.

**Publishing (hard rule):** only emulator services (`service-<name>`), the shared `runtime` they depend on, and the fleet and notifications tools are published. Every other package is `"private": true`. [`packages/runtime`](../packages/runtime/README.md) bundles the runtime helpers once (`core`, `service`, `sqlite`, `openapi`, `http-codec`, the admin page, …) and re-exports each as `@crvouga/mockingbird-runtime/<helper>`. A service builds with [`scripts/bundle-service.ts`](../scripts/bundle-service.ts) and lists `@crvouga/mockingbird-runtime` in `dependencies`: its imports of those helpers become imports of the runtime ([`scripts/bundle-service-runtime.ts`](../scripts/bundle-service-runtime.ts)), so emulators installed or bundled together share one runtime, and the build fails if it inlines a copy anyway. Anything else it uses is inlined (JavaScript and `.d.ts`), so the tarball needs nothing unpublished. `bun run check:boundaries` fails CI on any other public package and on a bundled service without the runtime dependency.

| Layer | Packages | Published |
| --- | --- | --- |
| Services | `service-stripe`, `service-junction`, `service-genebygene`, `service-medplum`, `service-postgres`, `service-sqlite`, and every vendor emulator in the [catalog](https://mockingbird.chrisvouga.dev/services) | yes |
| Runtime | `runtime`: the helpers below marked "runtime", built once and shared by every service | yes |
| Core | `core` (`FetchAPI`), `service` (Hono dispatch keyed by `operationId`) | runtime |
| Storage | `sqlite` (`SqliteClient` port, migrate runner, default `@crvouga/mockingbird-service-sqlite`) | runtime |
| Contract | `openapi`, `openapi-metadata` (runtime); `openapi-arbitrary`, `openapi-codegen` | runtime / build tool |
| Parity | `commands`, `model`, `canonicalize`, `parity` (runner) | bundled / tests |
| Adapters | `adapter-node` (runtime, for `./server` entries), `adapter-bun` | runtime / tests only |
| Auth | `credentials` (sandbox credentials for live parity, from the environment) | tests only |

## UI work: the Storybook catalog

Every piece of UI is a story in one catalog, [`sites/storybook`](../sites/storybook/README.md):
each emulator's hosted pages (Checkout, sign-in, consent, inboxes, inspectors) drawn by the real
emulator running in the browser, the Stripe.js Elements, the admin UIs, the example apps, the docs
site's pages and the reports. The Fleet Cloud dashboard and the notifications harness keep their
own Storybooks, which the catalog composes. Change UI there: open the story, edit the source, and
the story re-renders (packages are read from `src/`).

```sh
bun run storybook                            # http://localhost:6008, everything composed
bun run --cwd sites/storybook verify         # every story renders and plays without an error
bun run check:storybook                      # every UI source file is in some story
```

A new page, screen or state gets a story in the same change; `bun run check:storybook` (part of
`bun run check`) fails on a UI file no story catalogues. The catalog is published with the docs
site at [`/storybook/`](https://mockingbird.chrisvouga.dev/storybook/).

## Infrastructure health

`bun run health` checks deployed infrastructure and release readiness in one report. This is
separate from the offline quality gate: live checks need network access, `gh auth login`, and
an npm login to inspect private publisher settings. It never publishes, deploys, repairs
settings, dispatches workflows, or changes credentials.

```bash
bun run health                                  # every infrastructure check
bun run health -- npm docs images                # selected checks
bun run health -- --verbose                      # every observation, including optional gaps
bun run health -- --json > health.json            # machine-readable report, no log prefixes
bun run health -- trusted-publisher --interactive # permit npm security-key approval
bun run health -- --no-interactive               # disable browser approval in a terminal
```

| Check | What it verifies |
| --- | --- |
| `npm` | Every public service exists on npm; `latest` resolves, metadata and tarball integrity exist, current services are not deprecated, exact internal dependency pins exist, stable release tags agree with npm, current tags have GitHub Releases, and retired packages are absent or deprecated |
| `trusted-publisher` | Each public package trusts `crvouga/mockingbird`, `ci.yml`, an empty environment, and direct `npm publish`; missing packages and unreadable settings are distinct |
| `github` | Repository and Actions are enabled, main is protected, workflow files are registered and active, latest main runs succeed, schedules are not overdue, and the Actions cache stays below its 10 GiB budget |
| `secrets` | Required workflow secrets, effective repository/organization secret names, parity workflow env mappings, scheduled parity readiness, and optional local/on-demand credentials; values are never printed or fetched from GitHub |
| `docs` | Fresh shared hosting contract and authoritative fleet inventory, HTTPS pages and machine-readable routes, all service catalog entries, deployed `llms.txt` versus main, webhook runtime and read protection, and immutable deployed revision evidence |
| `images` | Anonymous GHCR pull access, `linux/amd64`, port 80, and `latest` matching the immutable SHA tag of the latest successful image publish |
| `repository` | Local release OIDC permissions, docs publishing contract, every public package's publish configuration, and generated agents/worktree/catalog/README/brand/parity configuration |

Turbo runs seven independent `health:<check>` root tasks and composes them with
`health:all`. Every health task has `cache: false`; `--continue=always` lets unrelated checks
finish after failures. Each invocation uses an isolated temporary report directory, so old
passes cannot hide crashed, missing, or malformed task output. Debug a task directly with
`bun run health:docs`, or run selected tasks through Turbo with
`bunx turbo run health:npm health:images --continue=always`.

Exit **0** means every required check passed. Exit **1** means a failure, pending workflow,
missing access, or another unknown result. The default output lists required problems with
exact package/resource names, reasons, repair commands, and links; `--verbose` also lists all
healthy and optional observations. JSON includes `schemaVersion`, `checkedAt`, `healthy`, and
the complete per-resource reports. Optional cold parity integrations and local credentials
do not make production infrastructure fail; their missing keys and mappings remain visible
with `--verbose` or `--json`.

Terminal runs open npm's security-key approval when needed and display the link while it is
active. Approve it, preferably with its temporary two-factor skip, to inspect all publishers.
JSON, CI, and `--no-interactive` runs never prompt; publisher health stays **unknown** if npm
requires approval. Other checks continue independently. Use `--interactive` to explicitly
enable approval outside a terminal. To repair publisher settings after inspecting the report,
use `bun run release:seed -- --trust-only`.

The docs build freezes a deterministic source fingerprint into `/health.json`, independent
of runtime files, secrets, and `.git`. Health compares it with GitHub's current main source
tree; stale or malformed manifests fail, and an older image without the endpoint remains
**unknown** until the managed publish workflow deploys it. HTTP availability alone cannot
clear that result. The optional webhook receiver may omit `WEBHOOK_READ_TOKEN` only when
fleet inventory does not declare it and unauthenticated reads fail closed with HTTP 503.
A declared but unavailable token, or public event reads, fails.

Secret presence does not prove a token is valid or unexpired. Health diagnoses failed
Junction verification artifacts, including vendor HTTP 401/402/403 access blockers, without
printing API response bodies or running billable parity suites. Restore vendor account
access or the named credential, then retry the workflow; access failures never pass as
healthy emulator parity. Run `parity:remote` for behavioral verification against a sandbox.

`bun run secrets:doctor` remains a compatibility shortcut to the same npm, publisher, and
secrets checks and accepts the same reporting flags.

## Quality gates

Every check is a single command you can run locally. `bun run check` runs the whole turbo graph; `bun run check:full` replicates CI end-to-end (install + commitlint + check).

A pull request is held only by **Commitlint** and **Check** (Biome format and lint), so it merges in about a minute. Everything else is a **release check**: it runs on `main` after the merge, in the Release workflow ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)), and holds the publish rather than the merge. A failing release check, or a failing publish job, upserts a GitHub issue labelled `ci-failure` and `agent-reported`: one per check, and one per failing turbo task for Static and the shards (`@crvouga/mockingbird-ui#test`), with the command that reproduces it. Later failures comment on it, a check that breaks again reopens its issue, and it closes itself when the check passes on `main`. Those issues head the [`/resolve-issues`](#agent-commands) queue, so a red `main` is queued work, fixed forward from its issue.

The release checks run the same turbo graph as `bun run check`, spread over parallel runners ([`scripts/ci-plan.ts`](../scripts/ci-plan.ts) splits it and fails if the split drifts from the `check` script): a **Static** job (format, lint, boundaries, generated-file drift) and four **Shard** jobs, each running build, typecheck, test, pack and portability for a quarter of the packages. **Consumer smoke**, **npm names** and the **Fleet container** build run beside them. Every package is in scope on each run; turbo's content hashes replay whatever did not change. The **Release checks** job passes when all of them passed, and the publish needs it.

The GitHub Actions cache is the remote cache ([`.github/actions/setup`](../.github/actions/setup/action.yml)); there is no turbo token or server. The release checks run on every push to `main`, so `main` holds a warm turbo cache per job for previews, parity runs and the next release. Each job saves only the task hashes it used, `node_modules` is cached from `main` only, and [`cache-cleanup.yml`](../.github/workflows/cache-cleanup.yml) deletes a PR's caches when it closes and trims `main`'s weekly. Locally turbo uses the same cache directory on disk.

Live parity (the [Parity](../.github/workflows/parity.yml) workflow) also runs after the merge, for each **hot** service whose dependency graph the merged change reaches (see [Parity tiers](TESTING.md#parity-tiers); [`scripts/affected.ts`](../scripts/affected.ts) reads Turborepo's graph). It depends on live vendors, so a failure opens an issue like any other release check but never holds the publish.

```bash
bun run setup          # first time: install + build
bun run check          # every gate below, in parallel, cached by turbo
bun run check:full     # mirrors the pull-request gate and the release checks
```

| Gate | Command | What it enforces |
| --- | --- | --- |
| Format | `bun run check:format` | [Biome](https://biomejs.dev) formatting |
| Lint | `bun run lint` | Biome lint (types, style, complexity) |
| Typecheck | `bun run typecheck` | `tsc` for every package. `@crvouga/mockingbird-service-conformance` proves each HTTP emulator's `createRuntime` accepts `{ sqlite?, clock?, seed?, adminKey? }` and returns the shared `MockSurface` |
| Boundaries | `bun run check:boundaries` | Intra-workspace dep graph plus the state architecture: internal deps resolve, no cycles or self-deps, imports are declared, published dependency rules hold, and providers cannot bypass or reimplement the shared Timeline history coordinator |
| Package integrity | `bun run pack:check` | `dist` + `exports` + `files`, tarball contents, [publint](https://publint.dev), [arethetypeswrong](https://arethetypeswrong.github.io) (ESM-only consumer resolution) |
| Portability | `bun run portability` | Every service emulator's published entry runs in Node, Bun, browsers, and Workers. The check fails when that entry uses a Node- or Bun-only API. A `./server` or CLI entry may use Node |
| Generate & OpenAPI | `bun run generate` / `bun run openapi:check` | Regenerate and verify provider contracts |
| Test | `bun run test` | Contract, integration, unit, fuzz, and property suites (`FC_NUM_RUNS=40` in CI) |
| Consumer docs | `bun run pack:check` | Every public package ships a README that opens with the shared epigraph from `sites/docs/src/lib/content.ts`, then `## Install`, `## Usage` (a TypeScript example) and `## API` listing every runtime export |
| Consumer smoke | `bun run release:smoke` | Packs every public package like the release, `npm install`s the tarballs into a clean project, imports every entry point under Node, and typechecks them plus every README TypeScript example |
| llms.txt | `bun run check:llms` | [`llms.txt`](../llms.txt) lists every published emulator with the parity it declares (`bun run llms:sync` regenerates) |
| README | `bun run check:readme` | [`README.md`](../README.md) is the overview, generated from `sites/docs/src/lib/content.ts` and these guides (`bun run readme:sync` regenerates). The catalog of emulators stays on the docs site. Never edit the README by hand |
| Vendor branding | `bun run check:brands` | `sites/docs/src/data/brands.json` has a logo, color and description for every service's `mockingbird.vendor` (`bun run brands:sync` fetches them; `-- --all --links` refreshes all and checks the links). Each service build embeds its own record (logo inlined) and serves it at `/__admin/ui/brands.json`, so admin shells never fetch the docs site |
| Docs site | `bun run docs:build` (part of `build`) | [`sites/docs`](../sites/docs) renders the same sources, sends every playground sample to a fresh emulator, runs the quick start and SQL snippets, and fails on missing or stale service metadata |
| Agent commands | `bun run check:agents` | Every `.agents/commands/*.md` is symlinked into each agent harness (`bun run agents:sync` repairs) |
| Parity tiers | `bun run check:parity-tiers` | Every service's `mockingbird.parityTier` is `hot`, `warm` or `cold` (absent means cold) |
| Worktree lifecycle | `bun run check:worktree` | Every orchestrator's config (`.superset/`, `.super.engineering/`) runs the same [`scripts/worktree`](../scripts/worktree/README.md) setup, run and teardown (`bun run worktree:sync` regenerates) |
| Scripts | `bun run check:scripts` | Every `scripts/**/*.ts` typechecks under the base tsconfig (`scripts/tsconfig.json`), and `bun test ./scripts` passes |
| Workflows | `bun run check:workflows` | Every `.github/workflows/*.yml` passes a pinned, checksum-verified [actionlint](https://github.com/rhysd/actionlint) (its `run:` scripts through shellcheck when that is installed, as on GitHub's runners) |

### Git hooks (Husky)

[`commit-msg`](../.husky/commit-msg) runs [commitlint](https://commitlint.js.org) via `bunx` for **every commit**, so Conventional Commits are enforced before they reach a PR. Disable hooks per-repo with `HUSKY=0` in `package.json` scripts, or bypass a single commit with `git commit --no-verify` (not recommended).

Keep the committed hook file in `.husky/commit-msg` — the generated `.husky/_` shims are gitignored and are produced by the `prepare` script (`husky`) on install.

### Trunk, checks, and release

`main` is the only long-lived branch. The ruleset rejects direct pushes and force-pushes, with no
bypass, so every change lands through a pull request. The only requirement to merge is that every
pull-request check has passed:

| Check | What it is |
| --- | --- |
| Commitlint | Conventional Commits on the PR's commits, and a Conventional Commits title |
| Check | Biome format and lint over the whole repository |

There is no
required review, no required approval, and an unresolved review thread does not block the merge.
Merging to `main` starts the Release workflow
([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)): it runs the release checks (build,
typecheck, tests, pack, portability, the consumer smoke and the rest of `bun run check`) on the
commit that landed and publishes only if they pass. A failure there does not undo the merge; it
opens a `ci-failure` issue to fix forward. The branch must be up
to date with `main` before merge. Only merge
commits are allowed, because each commit on the pull request is a release input. Head branches
are deleted on merge. PRs use the template in `.github/pull_request_template.md`.

The gate is codified in `scripts/pr-ready.ts` (`REQUIRED_CHECKS` is the ruleset list — rename a
job in [`.github/workflows/pr.yml`](../.github/workflows/pr.yml) and update that list together):

```bash
bun run pr:ready repo                            # verify merge settings / auto-delete / auto-merge
bun run pr:ready repo --apply
bun run pr:ready ruleset                         # verify the `Protect main` ruleset
bun run pr:ready ruleset --apply
```

### Failure notifications

There is no failure-issue workflow: GitHub already emails a workflow's failures on `main` to whoever
triggered the run, and an extra `workflow_run` workflow after every run doubled the Actions volume.

### Agent commands

Agent commands are written once in [`.agents/commands/`](../.agents/commands) and symlinked into every
harness — `.claude/commands`, `.cursor/commands`, `.opencode/command`, `.windsurf/workflows`,
`.github/prompts` (Copilot), and `.agents/skills/<name>/SKILL.md` (Codex / Agent Skills). Edit the
canonical file; `bun run agents:sync` creates missing links and `bun run check:agents` (part of
`bun run check`) fails CI on drift.

`/pr-ready` takes the current branch to a merge-ready PR: commit, push, merge `origin/main`,
resolve conflicts, open the PR, and fix every failing check (CI and third-party checks).
Auto-merge is the default: `bun run pr:ready pr` (and `advance`) enables it with a merge commit on
every open, non-draft PR, so the PR lands itself once the required checks pass; `ready` only
verifies. It is enabled by the agent's own `gh` credentials, never by a workflow with
`GITHUB_TOKEN`: a merge made through `GITHUB_TOKEN` does not trigger the push workflows on `main`
(CI, Publish image), so nothing would release.
For a clean, committed branch, `bun run pr:ready advance` performs the mechanical steps in one call
and returns JSON for the next blocker. `bun run pr:ready comments` lists review threads and recent
comments when you want to read them.

`/resolve-issues` works the queue of GitHub issues that agents in other projects file through
[REPORTING_ISSUES.md](REPORTING_ISSUES.md) (label `agent-reported`): claim the selected issues, confirm
reported behavior against the oracle, add regression tests and fix the emulators. Every invocation
uses one branch, one existing worktree and one PR for the complete batch. Prioritize native
subagents per independent issue or issue group in that same worktree; the coordinator integrates
and runs `/pr-ready` once, with a `Fixes #<n>` line for each fully resolved issue. `feature` requests become acceptance tests plus contract changes;
`new-service` requests become new packages built through
[AUTHORING_A_SERVICE.md](AUTHORING_A_SERVICE.md).
`bun github:resolve-issues [<issue…>]` runs that command on GitHub, unattended, as you. It starts
the [Resolve issues](../.github/workflows/resolve-issues.yml) workflow with a GitHub token minted for
the run, which expires within 8 hours and reaches only this repository, plus your Claude
subscription token. No repo secret is involved. One coordinator opens a single draft PR for the
batch, delegates independent issue groups to native subagents in its shared checkout, and carries
the combined PR to green with auto-merge enabled. Blocked issues are reported individually while independent
work continues. With no issue named, it takes the queue in the command's order. The
repo owner runs `bun github:resolve-issues setup` once first.
[SECRETS.md](SECRETS.md#resolving-issues-on-github) lists the safeguards.

### Package publishing

Published services use `publishConfig.access = "public"` and `publishConfig.provenance = true` (npm Trusted Publishing / OIDC). `bun run pack:check` is the pre-publish gate that confirms each package actually packs, resolves types for an ESM-only consumer, and ships `dist`.

### Docs site hosting

For local development, `bun run docs:dev` serves the docs and browser examples. Astro uses
separate Vite dependency caches under `sites/docs/node_modules/.vite/dev` and `.vite/build`,
so a production build does not replace modules served by an existing dev session. The lab
ordering example's browser dependencies are optimized before its first launch. To verify this
boundary, keep the dev server running, run `bun run docs:build`, then reload
`/examples/medical-testing` and open the Example, Notifications and Emulators tabs.

The docs site (`sites/docs`) is hosted by `crvouga/personal` as the service
`mockingbird-docs` ([cloud infrastructure guide §4](https://www.chrisvouga.dev/llms-cloud.txt)).
[`sites/docs/Dockerfile`](../sites/docs/Dockerfile) builds the static Astro site and serves it
with nginx on port 80. Its build context is the repo root, because the site renders every service
package. On every push to `main`, [`.github/workflows/publish.yml`](../.github/workflows/publish.yml)
calls `crvouga/personal`'s reusable publish workflow. That workflow pushes `ghcr.io/crvouga/chrisvouga-mockingbird-docs:<sha>`,
and then `crvouga/personal` deploys that exact image and health-checks it. Railway never builds this repo.

To check the image locally, run `docker build -f sites/docs/Dockerfile -t mockingbird-docs . && docker run --rm -p 8080:80 mockingbird-docs`.
