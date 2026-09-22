# Developing Mockingbird

Working on this repo: requirements, how the packages are layered, and the quality gates every change passes.

## Requirements

- **Node.js ≥ 22** or **Bun ≥ 1.2** (ESM only).
- npm is required for the package-integrity gates (`bunx publint`, `bunx attw`); Bun runs the rest.

Install with `bun install` (uses [workspaces](https://bun.sh/docs/install/workspaces) + [Turborepo](https://turbo.build/repo/docs/overview)). A git hook lints commit messages on the spot — see [Development](#development--quality-gates).

## Packages

**Naming (hard rule):** every package is `@crvouga/mockingbird-<kebab-case>`; the short names below drop that prefix. `bun run check:boundaries` fails CI on any other name.

**Publishing (hard rule):** only mock services (`service-<name>`) are published. Every other package is `"private": true`; a service that uses them builds with [`scripts/bundle-service.ts`](../scripts/bundle-service.ts), which inlines them (JavaScript and `.d.ts`) so the tarball needs nothing unpublished. `bun run check:boundaries` fails CI on a public non-service package.

| Layer | Packages | Published |
| --- | --- | --- |
| Services | `service-stripe`, `service-junction`, `service-genebygene`, `service-medplum`, `service-postgres`, `service-sqlite`, and every vendor mock in the [catalog](../README.md#services) | yes |
| Core | `core` (`FetchAPI`), `service` (Hono dispatch keyed by `operationId`) | bundled |
| Storage | `sqlite` (`SqliteClient` port, migrate runner, default `@crvouga/mockingbird-service-sqlite`) | bundled |
| Contract | `openapi`, `openapi-metadata`, `openapi-arbitrary`, `openapi-codegen` | bundled / build tool |
| Parity | `commands`, `model`, `canonicalize`, `parity` (runner) | bundled / tests |
| Adapters | `adapter-node`, `adapter-bun` | tests only |
| Auth | `openbao` (sandbox credentials for live parity) | tests only |

## Quality gates

Every merge-blocking check is a single command you can run locally. `bun run check` runs the whole turbo graph; `bun run check:full` replicates CI end-to-end (install + commitlint + check) without the network-only release job.

CI is one turbo graph: the `Check` job runs `bun run check` with `node_modules` in the GitHub Actions cache and task outputs in the shared self-hosted **Turborepo remote cache** (`https://turborepo.chrisvouga.dev`), so a PR only rebuilds and retests the packages it changed, and the release job replays build/pack results instead of rebuilding. Local runs share the same cache: root turbo scripts run under `vault run` ([`scripts/vault-run.ts`](../scripts/vault-run.ts)), which injects `TURBO_*` from Vault. CI gets them through Vault GitHub OIDC — no stored token. Setup: [docs/SECRETS.md](SECRETS.md).

```bash
bun install            # workspaces + generates dist
bun run check          # every gate below, in parallel, cached by turbo
bun run check:full     # mirrors .github/workflows/ci.yml (local CI replica)
```

| Gate | Command | What it enforces |
| --- | --- | --- |
| Format | `bun run check:format` | [Biome](https://biomejs.dev) formatting |
| Lint | `bun run lint` | Biome lint (types, style, complexity) |
| Typecheck | `bun run typecheck` | `tsc` for every package |
| Boundaries | `bun run check:boundaries` | Intra-workspace dep graph plus the state architecture: internal deps resolve, no cycles or self-deps, imports are declared, published dependency rules hold, and providers cannot bypass or reimplement the shared Timeline history coordinator |
| Package integrity | `bun run pack:check` | `dist` + `exports` + `files`, tarball contents, [publint](https://publint.dev), [arethetypeswrong](https://arethetypeswrong.github.io) (ESM-only consumer resolution) |
| Portability | `bun run portability` | Built `dist` matches the package's `mockingbird.runtime` (portable / node / bun) — no Node/Bun-only API usage where it isn't allowed |
| Generate & OpenAPI | `bun run generate` / `bun run openapi:check` | Regenerate and verify provider contracts |
| Test | `bun run test` | Contract, integration, unit, fuzz, and property suites (`FC_NUM_RUNS=40` in CI) |
| Consumer docs | `bun run pack:check` | Every public package ships a README with `## Install`, `## Usage` (a TypeScript example) and `## API` listing every runtime export |
| Consumer smoke | `bun run release:smoke` | Packs every public package like the release, `npm install`s the tarballs into a clean project, imports every entry point under Node, and typechecks them plus every README TypeScript example |
| llms.txt | `bun run check:llms` | [`llms.txt`](../llms.txt) lists every published mock service by release tier (`bun run llms:sync` regenerates) |
| README | `bun run check:readme` | [`README.md`](../README.md) is generated from `sites/docs/src/lib/content.ts`, every service's `package.json` and these guides (`bun run readme:sync` regenerates); never edit it by hand |
| Docs site | `bun run docs:build` (part of `build`) | [`sites/docs`](../sites/docs) renders the same sources, sends every playground sample to a fresh mock, runs the quick start and SQL snippets, and fails on missing or stale service metadata |
| Agent commands | `bun run check:agents` | Every `.agents/commands/*.md` is symlinked into each agent harness (`bun run agents:sync` repairs) |

### Git hooks (Husky)

[`commit-msg`](../.husky/commit-msg) runs [commitlint](https://commitlint.js.org) via `bunx` for **every commit**, so Conventional Commits are enforced before they reach a PR. Disable hooks per-repo with `HUSKY=0` in `package.json` scripts, or bypass a single commit with `git commit --no-verify` (not recommended).

Keep the committed hook file in `.husky/commit-msg` — the generated `.husky/_` shims are gitignored and are produced by the `prepare` script (`husky`) on install.

### Trunk & PR workflow

`main` is the only long-lived branch. Every change lands through a PR that targets `main`, and
only merge commits are allowed (squash and rebase are disabled). Head branches are deleted on
merge, and the aggregate `Required` job (Commitlint + Check + the trunk policy) is the required
status check, with no bypass actors. PRs use the minimal template in
`.github/pull_request_template.md`. The gate is codified in `scripts/pr-merge.ts`:

```bash
bun run pr:merge repo                            # verify merge settings / auto-delete / auto-merge
bun run pr:merge repo --apply
bun run pr:merge ruleset                         # verify the `Protect main` ruleset
bun run pr:merge ruleset --apply
```

### Agent commands

Agent commands are written once in [`.agents/commands/`](../.agents/commands) and symlinked into every
harness — `.claude/commands`, `.cursor/commands`, `.opencode/command`, `.windsurf/workflows`,
`.github/prompts` (Copilot), and `.agents/skills/<name>/SKILL.md` (Codex / Agent Skills). Edit the
canonical file; `bun run agents:sync` creates missing links and `bun run check:agents` (part of
`bun run check`) fails CI on drift.

`/pr-merge` takes the current branch all the way to a merged PR: commit, push, merge `origin/main`,
resolve conflicts, open the PR, fix every failing check (CI and third-party checks such as
GitGuardian), then merge automatically once everything is green.

`/resolve-issues` works the queue of GitHub issues that agents in other projects file through
[REPORTING_ISSUES.md](REPORTING_ISSUES.md) (label `agent-reported`): claim one, confirm the
reported behavior against the oracle, add a regression test, fix the mock, and ship it through
`/pr-merge` with `Fixes #<n>`. `feature` requests become acceptance tests plus contract changes;
`new-service` requests become new packages built through
[AUTHORING_A_SERVICE.md](AUTHORING_A_SERVICE.md).

### Package publishing

Published services use `publishConfig.access = "public"` and `publishConfig.provenance = true` (npm Trusted Publishing / OIDC). `bun run pack:check` is the pre-publish gate that confirms each package actually packs, resolves types for an ESM-only consumer, and ships `dist`.

### Docs site hosting

The docs site (`sites/docs`) is hosted on the shared `crvouga/workspace` fleet as the service
`mockingbird-docs` ([shared-infra contract §4](https://raw.githubusercontent.com/crvouga/workspace/main/llms.txt)).
[`sites/docs/Dockerfile`](../sites/docs/Dockerfile) builds the static Astro site and serves it
with nginx on port 80. Its build context is the repo root, because the site renders every service
package. On every push to `main`, [`.github/workflows/publish.yml`](../.github/workflows/publish.yml)
calls the workspace's reusable workflow. That workflow pushes `ghcr.io/crvouga/chrisvouga-mockingbird-docs:<sha>`,
and then `crvouga/workspace` deploys that exact image and health-checks it. Railway never builds this repo.

To check the image locally, run `docker build -f sites/docs/Dockerfile -t mockingbird-docs . && docker run --rm -p 8080:80 mockingbird-docs`.
