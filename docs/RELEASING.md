# Releasing

How packages get from `main` to npm using Trusted Publishing, without a stored npm token.

A pull request whose checks passed is releasable. Merging it to `main` is the release. The Release workflow ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) then publishes; it does not re-run Commitlint, Check, or the consumer smoke. Those already passed on the pull request ([`.github/workflows/pr.yml`](../.github/workflows/pr.yml)). Manual dispatch and a run every six hours only retry an interrupted publish ([`scripts/release/`](../scripts/release/lib.ts)):

- **Which packages:** every published service with a releasable Conventional Commit since its last `<name>@<version>` git tag — in its own directory or in any private helper it bundles — every service that has never been released, and every service that depends at runtime on one of those (workspace deps are pinned exactly).
- **Which version:** `feat!` / `BREAKING CHANGE` → major, `feat` → minor, `fix` / `perf` / `revert` / `refactor` / `build` / `docs` → patch, dependency-only → patch. `test` / `ci` / `chore` / `style` never release a package on their own. First releases start at `0.1.0`.
- **How:** build (replaying main's Turborepo cache from the GitHub Actions cache) → `bun pm pack` → `npm publish --provenance` via npm Trusted Publishing (OIDC) → push the `<name>@<version>` tag → GitHub Release with that package's notes. `pack:check`, portability, and the consumer smoke already ran as the Check job.

Versions live in tags, so `package.json` keeps `0.0.0-development` and nothing is committed back to `main` (same model as semantic-release). Every step is idempotent — re-running a failed release job finishes it.

OIDC cannot create a package that does not exist on npm yet. A maintainer runs `bun run release:seed` once with an interactive npm login; it first-publishes missing packages from `origin/main`, attaches `ci.yml` as each package's Trusted Publisher (`npm trust github`), and reconciles deprecations. The seed spaces bulk trust changes at npm's recommended interval and fails with the exact packages it could not configure; rerunning resumes safely. CI never receives or falls back to a long-lived npm token. Until the seed runs, a never-published package fails the release (as do its dependents), while every independent package still releases. See [docs/SECRETS.md](SECRETS.md).

```bash
bun run release:plan                   # what the next push to main would release
bun run release:publish -- --dry-run   # plan + pack every tarball, no side effects
bun run release:seed                   # reconcile npm with origin/main using your npm login
bun run release:seed -- --trust-only   # repair existing packages' publishers; no build or publish
bun run health                         # unified release, deployment, and infrastructure health
bun run health -- trusted-publisher --interactive # inspect settings requiring npm approval
bun run secrets:doctor                 # npm / Trusted Publishing / live parity status
```

For an existing package rejected with `ENEEDAUTH`, use `bun run release:seed -- --trust-only`.
It uses your interactive npm login, repairs the publisher for every published service, and
reads the settings back to verify the repository, `ci.yml`, empty environment, and permission
to publish. It runs in the current checkout without creating a worktree, building, publishing,
tagging, or deprecating packages. Then retry Release. A green run with nothing to release does
not verify OIDC access: locally published versions are skipped by CI.

The seed deprecates npm packages this repo no longer publishes: the former helper packages (`@crvouga/mockingbird`, `-core`, `-service`, `-sqlite`, `-openapi*`, `-http-codec`, `-commands`, `-model`, `-canonicalize`, `-parity`, `-adapter-*`, `-openbao`), now bundled into the services, and the archived `@crvouga/postgres-mem` / `@crvouga/sqlite-mem`, which continue here as `@crvouga/mockingbird-service-postgres` / `-sqlite`. OIDC only authenticates publish operations, so CI logs deprecations for the next local seed instead of managing package settings.

Local replica of the pull-request gate: `bun run check:full`.
