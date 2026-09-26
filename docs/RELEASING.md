# Releasing

How packages get from `main` to npm. Once the `NPM_TOKEN` repo secret is set, releases run automatically.

A pull request whose checks passed is releasable. Merging it to `main` is the release. The Release workflow ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) then publishes; it does not re-run Commitlint, Check, or the consumer smoke. Those already passed on the pull request ([`.github/workflows/pr.yml`](../.github/workflows/pr.yml)). Manual dispatch and a run every six hours only retry an interrupted publish ([`scripts/release/`](../scripts/release/lib.ts)):

- **Which packages:** every published service with a releasable Conventional Commit since its last `<name>@<version>` git tag — in its own directory or in any private helper it bundles — every service that has never been released, and every service that depends at runtime on one of those (workspace deps are pinned exactly).
- **Which version:** `feat!` / `BREAKING CHANGE` → major, `feat` → minor, `fix` / `perf` / `revert` / `refactor` / `build` / `docs` → patch, dependency-only → patch. `test` / `ci` / `chore` / `style` never release a package on their own. First releases start at `0.1.0`.
- **How:** build (replaying main's Turborepo cache from the GitHub Actions cache) → `bun pm pack` → `npm publish --provenance` via npm Trusted Publishing (OIDC) → push the `<name>@<version>` tag → GitHub Release with that package's notes. `pack:check`, portability, and the consumer smoke already ran as the Check job.

Versions live in tags, so `package.json` keeps `0.0.0-development` and nothing is committed back to `main` (same model as semantic-release). Every step is idempotent — re-running a failed release job finishes it.

OIDC cannot create a package that does not exist on npm yet. The release job reads the `NPM_TOKEN` GitHub Actions secret, creates missing packages with it, and attaches their Trusted Publisher automatically (`npm trust github`). `bun run release:bootstrap` securely prompts for a missing token, stores it as the repo secret with `gh secret set`, and starts the current CI workflow on `main`. `bun run release:seed` remains a local fallback using npm login; it reconciles npm with `origin/main` in a temporary worktree. See [docs/SECRETS.md](SECRETS.md).

```bash
bun run release:plan                   # what the next push to main would release
bun run release:publish -- --dry-run   # plan + pack every tarball, no side effects
bun run release:seed                   # reconcile npm with origin/main using your npm login
bun run release:bootstrap              # set the NPM_TOKEN repo secret and run current CI on main
bun run secrets:doctor                 # npm / Trusted Publishing / NPM_TOKEN status
```

Every release (and the seed) deprecates npm packages this repo no longer publishes: the former helper packages (`@crvouga/mockingbird`, `-core`, `-service`, `-sqlite`, `-openapi*`, `-http-codec`, `-commands`, `-model`, `-canonicalize`, `-parity`, `-adapter-*`, `-openbao`), now bundled into the services, and the archived `@crvouga/postgres-mem` / `@crvouga/sqlite-mem`, which continue here as `@crvouga/mockingbird-service-postgres` / `-sqlite`. Deprecating needs account auth (`NPM_TOKEN` or the seed); OIDC alone only logs what it would deprecate.

Local replica of the pull-request gate: `bun run check:full`.
