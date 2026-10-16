/**
 * Seed npm: reconcile the npm registry with origin/main, from your own npm login.
 *
 * Only mock services (`@crvouga/mockingbird-service-*`) are published; every other
 * workspace package is private and bundled into the services. Reconciling means:
 *   - publish every service that is not on npm yet (Trusted Publishing (OIDC) cannot
 *     create packages, so a maintainer does it once with an interactive npm login),
 *   - attach the GitHub Actions Trusted Publisher to every published service,
 *   - deprecate every package this repo no longer publishes (private helpers still on
 *     npm, and the archived @crvouga/postgres-mem / @crvouga/sqlite-mem).
 *
 * Steps:
 *   1. make sure npm >= 11.15 is on PATH (`npm trust` needs it; a private copy is used if not)
 *   2. make sure you are logged in to npm (runs `npm login` if not)
 *   3. check out origin/main in a kept worktree. A rerun reuses that install and build,
 *      and a checkout that is already origin/main and already built donates its dist.
 *   4. `release:publish --local` there, using this checkout's scripts/release (so a local
 *      fix applies before it is on main): publish, trust, tag, GitHub Releases, deprecate
 *
 * The seed is slow enough to walk away from, so whenever it waits on you (`npm login`, or an
 * npm 2FA approval for a publish or trust change) it rings the terminal bell and posts a desktop
 * notification, repeating until you answer (scripts/release/attention.ts).
 *
 * After this, every later release is published by CI through OIDC.
 * Idempotent: packages, trust, tags and deprecations that already exist are skipped,
 * so re-run it to finish. The worktree is kept on purpose; deleting it is what made
 * every rerun install and build origin/main again.
 *
 *   bun run release:seed               (reconcile)
 *   bun run release:seed -- --dry-run  (plan + pack, print what would change)
 *   bun run release:seed -- --trust-only (repair existing packages' publishers without a build)
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chdir } from "node:process"
import { $ } from "bun"
import { alertIfWaiting } from "./attention.ts"
import { root } from "./lib.ts"
import { seedCachePath } from "./seed-path.ts"

/**
 * Bun's shell calls getcwd() even when `.cwd()` is set, and throws ENOENT if this
 * process's directory was removed (oven-sh/bun#23589). `chdir` to a live absolute
 * path repairs that before the next `$` or spawn.
 */
function enter(dir: string) {
  if (!existsSync(dir)) throw new Error(`release:seed: missing directory ${dir}`)
  chdir(dir)
}

const dryRun = process.argv.includes("--dry-run")
const trustOnly = process.argv.includes("--trust-only")
const refreshRejected = process.argv.includes("--refresh-rejected")
if (refreshRejected && !trustOnly) throw new Error("--refresh-rejected requires --trust-only")
const MIN_NPM = [11, 15] as const

async function run(cmd: string[], cwd: string, env: Record<string, string | undefined>) {
  enter(cwd)
  const code = await Bun.spawn(cmd, { cwd, env, stdio: ["inherit", "inherit", "inherit"] }).exited
  enter(root)
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}`)
}

function npmIsRecentEnough(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number)
  return major > MIN_NPM[0] || (major === MIN_NPM[0] && minor >= MIN_NPM[1])
}

/** Public services in `dir` already have a packed entry. `conformance` and other private dirs are ignored. */
function distReady(dir: string): boolean {
  const service = join(dir, "packages/service")
  if (!existsSync(service)) return false
  let saw = 0
  for (const entry of readdirSync(service, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(service, entry.name, "package.json")
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      private?: boolean
      publishConfig?: { access?: string }
    }
    if (manifest.private === true || manifest.publishConfig?.access !== "public") continue
    saw += 1
    if (!existsSync(join(service, entry.name, "dist/index.js"))) return false
  }
  return saw > 0
}

/** Copy a tree, cloning files when the volume supports it. Symlinks stay symlinks. */
async function copyTree(from: string, to: string): Promise<boolean> {
  rmSync(to, { recursive: true, force: true })
  mkdirSync(join(to, ".."), { recursive: true })
  const cloned = await Bun.spawn(["cp", "-cR", from, to], {
    stdout: "ignore",
    stderr: "ignore",
  }).exited
  if (cloned === 0) return true
  rmSync(to, { recursive: true, force: true })
  const copied = await Bun.spawn(["cp", "-R", from, to], {
    stdout: "ignore",
    stderr: "inherit",
  }).exited
  return copied === 0
}

const env: Record<string, string | undefined> = { ...process.env }
delete env.NODE_AUTH_TOKEN
let npmScratch: string | undefined
enter(root)

try {
  // 1. npm new enough for `npm trust`.
  const npmVersion = (await $`npm --version`.quiet()).text().trim()
  if (!npmIsRecentEnough(npmVersion)) {
    console.log(
      `release:seed: npm ${npmVersion} is too old for \`npm trust\`; using npm@11 for this run`,
    )
    npmScratch = mkdtempSync(join(tmpdir(), "mockingbird-seed-npm-"))
    const prefix = join(npmScratch, "npm")
    await $`npm install --silent --no-audit --no-fund --prefix ${prefix} npm@11`.quiet()
    env.PATH = `${join(prefix, "node_modules/.bin")}:${process.env.PATH}`
  }

  // 2. npm login.
  if (!dryRun) {
    const whoami = await $`npm whoami`.env(env).quiet().nothrow()
    if (whoami.exitCode !== 0) {
      console.log("release:seed: not logged in to npm — running `npm login`")
      await alertIfWaiting(
        "npm login is waiting for you in this terminal",
        () => run(["npm", "login"], root, env),
        { afterMs: 0 },
      )
    }
    console.log(
      `release:seed: publishing as ${(await $`npm whoami`.env(env).quiet()).text().trim()}`,
    )
  }

  if (trustOnly) {
    // Account settings do not need a build, a main checkout, or a new package version.
    await run(
      [
        "bun",
        "scripts/release/publish.ts",
        "--local",
        "--trust-only",
        ...(refreshRejected ? ["--refresh-rejected"] : []),
        ...(dryRun ? ["--dry-run"] : []),
      ],
      root,
      env,
    )
  } else {
    // 3. A clean origin/main. Kept across runs so a crash does not rebuild the repo.
    const commonGitDir = (
      await $`git rev-parse --path-format=absolute --git-common-dir`.cwd(root).quiet()
    )
      .text()
      .trim()
    const cache = seedCachePath(commonGitDir)
    const stampPath = `${cache}.sha`
    await $`git fetch origin main --tags`.cwd(root).quiet()
    const sha = (await $`git rev-parse origin/main`.cwd(root).quiet()).text().trim()
    const head = (await $`git rev-parse HEAD`.cwd(root).quiet()).text().trim()
    if (!existsSync(join(cache, ".git"))) {
      mkdirSync(join(cache, ".."), { recursive: true })
      await $`git worktree add --detach ${cache} ${sha}`.cwd(root).quiet()
    } else {
      await $`git reset --hard ${sha}`.cwd(cache).quiet()
    }
    // This checkout's publisher, not origin/main's, so the retry fix runs before it is merged.
    for (const name of readdirSync(join(root, "scripts/release"))) {
      cpSync(join(root, "scripts/release", name), join(cache, "scripts/release", name), {
        recursive: true,
        force: true,
      })
    }

    const reused =
      existsSync(stampPath) &&
      readFileSync(stampPath, "utf8").trim() === sha &&
      existsSync(join(cache, "node_modules")) &&
      distReady(cache)
    if (reused) {
      console.log(`release:seed: reusing build of origin/main ${sha.slice(0, 7)}`)
    } else if (head === sha && distReady(root)) {
      console.log("release:seed: reusing this checkout's build of origin/main")
      const copiedModules = await copyTree(join(root, "node_modules"), join(cache, "node_modules"))
      if (!copiedModules) {
        console.log("release:seed: could not copy node_modules; installing and building instead")
        await run(["bun", "install", "--frozen-lockfile"], cache, env)
        await run(["bun", "run", "build"], cache, env)
      } else {
        const service = join(root, "packages/service")
        for (const entry of readdirSync(service, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          const from = join(service, entry.name, "dist")
          if (!existsSync(from)) continue
          if (!(await copyTree(from, join(cache, "packages/service", entry.name, "dist")))) {
            throw new Error(`release:seed: could not copy ${from}`)
          }
        }
      }
      writeFileSync(stampPath, sha)
    } else {
      console.log(`release:seed: installing and building origin/main ${sha.slice(0, 7)}`)
      await run(["bun", "install", "--frozen-lockfile"], cache, env)
      await run(["bun", "run", "build"], cache, env)
      writeFileSync(stampPath, sha)
    }

    // 4. Publish, trust, tag, release, deprecate.
    await run(["bun", "scripts/release/publish.ts", dryRun ? "--dry-run" : "--local"], cache, env)
  }
} catch (error) {
  console.error(`release:seed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  try {
    enter(root)
  } catch {
    // The checkout this process started in is gone; removal below uses absolute paths.
  }
  if (npmScratch) rmSync(npmScratch, { recursive: true, force: true })
}
