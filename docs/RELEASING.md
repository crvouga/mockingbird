# Releasing

How packages get from `main` to npm using Trusted Publishing, without a stored npm token.

A pull request whose checks passed is releasable. Merging it to `main` is the release. The Release workflow ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) then publishes; it does not re-run Commitlint, Check, or the consumer smoke. Those already passed on the pull request ([`.github/workflows/pr.yml`](../.github/workflows/pr.yml)). Manual dispatch and a run every six hours only retry an interrupted publish ([`scripts/release/`](../scripts/release/lib.ts)):

- **Which packages:** every published service with a releasable Conventional Commit since its last `<name>@<version>` git tag — in its own directory or in any private helper it bundles — every service that has never been released, and every service that depends at runtime on one of those (workspace deps are pinned exactly).
- **Which version:** `feat!` / `BREAKING CHANGE` → major, `feat` → minor, `fix` / `perf` / `revert` / `refactor` / `build` / `docs` → patch, dependency-only → patch. `test` / `ci` / `chore` / `style` never release a package on their own. First releases start at `0.1.0`.
- **How:** freeze one release plan → build and publish prerequisites (currently SQLite) → build and publish the remaining services across up to eight parallel matrix shards → reconcile missing GitHub Releases and retired packages once. Each runner builds only its assigned packages and their build dependencies, replaying main's Turborepo cache from the GitHub Actions cache. Publishing runs `bun pm pack` → `npm publish --provenance` via npm Trusted Publishing (OIDC) → push the `<name>@<version>` tag → GitHub Release with that package's notes. `pack:check`, portability, and the consumer smoke already ran as the Check job.

Versions live in tags, so `package.json` keeps `0.0.0-development` and nothing is committed back to `main` (same model as semantic-release). Every step is idempotent — re-running a failed release job finishes it.

The plan artifact records the commit, versions, and notes before any job pushes tags. Every shard uses that same snapshot rather than recalculating versions as other jobs finish. Packages another release depends on publish first, in dependency order; leaf shards have no dependencies on each other. A failed prerequisite does not stop independent packages: shards verify every dependency pin on npm before publishing. A failed shard does not cancel the others, and reconciliation runs even after a publish failure or when there are no new versions.

OIDC cannot create a package that does not exist on npm yet. A maintainer runs `bun run release:seed` once with an interactive npm login; it first-publishes missing packages from `origin/main`, attaches `ci.yml` as each package's Trusted Publisher (`npm trust github`), and reconciles deprecations. The seed spaces bulk trust changes at npm's recommended interval and fails with the exact packages it could not configure; rerunning resumes safely. CI never receives or falls back to a long-lived npm token. Until the seed runs, a never-published package fails the release (as do its dependents), while every independent package still releases. See [docs/SECRETS.md](SECRETS.md).

```bash
bun run release:plan                   # what the next push to main would release
bun run release:publish -- --dry-run   # plan + pack every tarball, no side effects
bun run release:seed                   # reconcile npm with origin/main using your npm login
bun run release:seed -- --trust-only   # repair existing packages' publishers; no build or publish
bun run release:seed -- --trust-only --refresh-rejected # refresh publishers rejected by the latest Release
bun run health                         # unified release, deployment, and infrastructure health
bun run health -- trusted-publisher --interactive # inspect settings requiring npm approval
bun run secrets:doctor                 # npm / Trusted Publishing / live parity status
```

For existing packages rejected with `ENEEDAUTH`, use
`bun run release:seed -- --trust-only --refresh-rejected`. It reads the latest completed
failed Release on `main` and recreates matching publisher settings for the packages that
run explicitly rejected, even when their saved fields already look correct. Other publisher
connections on those packages are preserved. This also requires `gh` access to the repo;
a running release must finish first, and a successful latest release refreshes no settings.

The command uses your interactive npm login, checks every published service, and
reads the settings back to verify the repository, `ci.yml`, empty environment, and permission
to publish. It runs in the current checkout without creating a worktree, building, publishing,
tagging, or deprecating packages. Then retry Release. A green run with nothing to release does
not verify OIDC access: locally published versions are skipped by CI.

The seed deprecates npm packages this repo no longer publishes: the former helper packages (`@crvouga/mockingbird`, `-core`, `-service`, `-sqlite`, `-openapi*`, `-http-codec`, `-commands`, `-model`, `-canonicalize`, `-parity`, `-adapter-*`, `-openbao`), now bundled into the services, and the archived `@crvouga/postgres-mem` / `@crvouga/sqlite-mem`, which continue here as `@crvouga/mockingbird-service-postgres` / `-sqlite`. OIDC only authenticates publish operations, so CI logs deprecations for the next local seed instead of managing package settings.

Local replica of the pull-request gate: `bun run check:full`.
