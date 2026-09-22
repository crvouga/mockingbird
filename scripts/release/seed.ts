/**
 * Seed npm: reconcile the npm registry with origin/main, from your own npm login.
 *
 * Only mock services (`@crvouga/mockingbird-service-*`) are published; every other
 * workspace package is private and bundled into the services. Reconciling means:
 *   - publish every service that is not on npm yet (Trusted Publishing (OIDC) cannot
 *     create packages, so without an NPM_TOKEN Actions secret a maintainer does it once),
 *   - attach the GitHub Actions Trusted Publisher to every published service,
 *   - deprecate every package this repo no longer publishes (private helpers still on
 *     npm, and the archived @crvouga/postgres-mem / @crvouga/sqlite-mem).
 *
 * Steps:
 *   1. make sure npm >= 11.10 is on PATH (`npm trust` needs it; a private copy is used if not)
 *   2. make sure you are logged in to npm (runs `npm login` if not)
 *   3. check out origin/main in a temporary worktree, install and build it
 *   4. `release:publish --local` there: publish, trust, tag, GitHub Releases, deprecate
 *
 * After this, every later release is published by CI through OIDC.
 * Idempotent: packages, trust, tags and deprecations that already exist are skipped,
 * so re-run it to finish.
 *
 *   bun run release:seed               (reconcile)
 *   bun run release:seed -- --dry-run  (plan + pack, print what would change)
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { $ } from "bun"
import { root } from "./lib.ts"

const dryRun = process.argv.includes("--dry-run")
const MIN_NPM = [11, 10] as const

async function run(cmd: string[], cwd: string, env: Record<string, string | undefined>) {
  const code = await Bun.spawn(cmd, { cwd, env, stdio: ["inherit", "inherit", "inherit"] }).exited
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}`)
}

function npmIsRecentEnough(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number)
  return major > MIN_NPM[0] || (major === MIN_NPM[0] && minor >= MIN_NPM[1])
}

const scratch = mkdtempSync(join(tmpdir(), "mockingbird-seed-"))
const worktree = join(scratch, "main")
const env: Record<string, string | undefined> = { ...process.env, NPM_TOKEN: "" }

try {
  // 1. npm new enough for `npm trust`.
  const npmVersion = (await $`npm --version`.quiet()).text().trim()
  if (!npmIsRecentEnough(npmVersion)) {
    console.log(
      `release:seed: npm ${npmVersion} is too old for \`npm trust\`; using npm@11 for this run`,
    )
    const prefix = join(scratch, "npm")
    await $`npm install --silent --no-audit --no-fund --prefix ${prefix} npm@11`.quiet()
    env.PATH = `${join(prefix, "node_modules/.bin")}:${process.env.PATH}`
  }

  // 2. npm login.
  if (!dryRun) {
    const whoami = await $`npm whoami`.env(env).quiet().nothrow()
    if (whoami.exitCode !== 0) {
      console.log("release:seed: not logged in to npm — running `npm login`")
      await run(["npm", "login"], root, env)
    }
    console.log(
      `release:seed: publishing as ${(await $`npm whoami`.env(env).quiet()).text().trim()}`,
    )
  }

  // 3. A clean origin/main, independent of the current checkout.
  await $`git fetch origin main --tags`.cwd(root).quiet()
  await $`git worktree add --detach ${worktree} origin/main`.cwd(root).quiet()
  await run(["bun", "install", "--frozen-lockfile"], worktree, env)
  await run(["bun", "run", "build"], worktree, env)

  // 4. Publish, trust, tag, release, deprecate.
  await run(["bun", "scripts/release/publish.ts", dryRun ? "--dry-run" : "--local"], worktree, env)
} catch (error) {
  console.error(`release:seed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await $`git worktree remove --force ${worktree}`.cwd(root).quiet().nothrow()
  rmSync(scratch, { recursive: true, force: true })
}
