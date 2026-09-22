# Releasing

How packages get from `main` to npm. There is nothing to run by hand.

Releases are fully automated on every green push to `main` ([`scripts/release/`](../scripts/release/lib.ts), job `Release` in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)). There is nothing to run by hand:

- **Which packages:** every published service with a releasable Conventional Commit since its last `<name>@<version>` git tag — in its own directory or in any private helper it bundles — every service that has never been released, and every service that depends at runtime on one of those (workspace deps are pinned exactly).
- **Which version:** `feat!` / `BREAKING CHANGE` → major, `feat` → minor, `fix` / `perf` / `revert` / `refactor` / `build` / `docs` → patch, dependency-only → patch. `test` / `ci` / `chore` / `style` never release a package on their own. First releases start at `0.1.0`.
- **How:** build → `pack:check` → `portability` → consumer smoke → `bun pm pack` → `npm publish --provenance` via npm Trusted Publishing (OIDC) → push the `<name>@<version>` tag → GitHub Release with that package's notes.

Versions live in tags, so `package.json` keeps `0.0.0-development` and nothing is committed back to `main` (same model as semantic-release). Every step is idempotent — re-running a failed release job finishes it.

OIDC cannot create a package that does not exist on npm yet. With the optional `NPM_TOKEN` Actions secret set, the release job creates new packages with it and attaches their Trusted Publisher automatically (`npm trust github`); without it, seed them once with `bun run release:seed`. The seed reconciles npm with `origin/main` (logs in to npm if needed, builds a clean `origin/main` in a temporary worktree, publishes every missing service, attaches Trusted Publishers, pushes tags and GitHub Releases, and deprecates every package no longer published). See [docs/SECRETS.md](SECRETS.md).

```bash
bun run release:plan                   # what the next push to main would release
bun run release:publish -- --dry-run   # plan + pack every tarball, no side effects
bun run release:seed                   # reconcile npm with origin/main using your npm login
bun run secrets:doctor                 # npm / Trusted Publishing / NPM_TOKEN status
```

Every release (and the seed) deprecates npm packages this repo no longer publishes: the former helper packages (`@crvouga/mockingbird`, `-core`, `-service`, `-sqlite`, `-openapi*`, `-http-codec`, `-commands`, `-model`, `-canonicalize`, `-parity`, `-adapter-*`, `-openbao`), now bundled into the services, and the archived `@crvouga/postgres-mem` / `@crvouga/sqlite-mem`, which continue here as `@crvouga/mockingbird-service-postgres` / `-sqlite`. Deprecating needs account auth (`NPM_TOKEN` or the seed); OIDC alone only logs what it would deprecate.

Local replica of the whole CI (minus the main-only release job): `bun run check:full`.
