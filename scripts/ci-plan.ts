/**
 * How the pull-request gate (.github/workflows/pr.yml) splits `bun run check` across runners, and
 * which of those runners a change needs.
 *
 * `bun run check` stays the one definition of the gate. Its tasks are split two ways:
 *   static  — `lint` plus every root task (`//#…` in turbo.json), including SQL type/performance
 *             checks whose bounded upstream builds come through turbo dependencies.
 *   shard   — every other task (build, typecheck, test, pack:check, …), with the workspace
 *             packages dealt round-robin into SHARDS parallel runners. Upstream builds a shard
 *             needs come along through turbo's `dependsOn`.
 * Together they are exactly the `check` script's task list; `changes` fails if they drift.
 *
 * Turbo's content hashes are the fine-grained filter: an unchanged package replays from cache.
 * `changes` is the coarse one, and works on Turborepo's dependency graph (scripts/affected.ts): a
 * package is affected when a file in it or in a workspace package it depends on, transitively,
 * changed. The shards run only the affected packages, and live parity only the hot services among
 * them. A file that belongs to no package and is not on a list of paths the shards provably do not
 * read runs every package.
 *
 *   bun scripts/ci-plan.ts changes --base origin/main   # what a PR against main would run
 *   bun scripts/ci-plan.ts changes --all                # push to main: everything
 *   bun scripts/ci-plan.ts static                       # the static job
 *   bun scripts/ci-plan.ts shard 2/4                    # one shard job
 *   bun scripts/ci-plan.ts smoke-key                    # fingerprint of what the smoke installs
 *
 * Extra arguments to `static` and `shard` go to turbo (e.g. `--output-logs=errors-only`).
 */
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { $ } from "bun"
import {
  affectedPackages,
  loadGraph,
  lockfileImpactSince,
  type WorkspaceGraph,
} from "./affected.ts"
import { parityServices } from "./parity-tiers.ts"
import { discoverPackages } from "./release/lib.ts"

const root = join(import.meta.dir, "..")

/** Parallel shard runners. .github/actions/setup restores one turbo cache per shard. */
const SHARDS = 4

/**
 * Paths no shard task reads: not a package input, not a turbo global dependency, not a build
 * script. A change made only of these skips the shards (and the consumer smoke).
 */
const SHARD_IRRELEVANT = [
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "LICENSE",
  "commitlint.config.js",
  "secrets.manifest.yaml",
  ".husky/**",
  ".agents/**",
  ".claude/**",
  ".cursor/**",
  ".opencode/**",
  ".windsurf/**",
  ".superset/**",
  ".super.engineering/**",
  ".github/prompts/**",
  ".github/ISSUE_TEMPLATE/**",
  ".github/labels.json",
  ".github/pull_request_template.md",
  // Workflows other than pr.yml do not change what the pull-request gate runs.
  ".github/workflows/{advisory,cache-cleanup,ci,issue-labels,parity,publish,resolve-issues,verify}.yml",
  // Read only by junction's live parity script (its `parityInputs`).
  "PARITY_FAILURE_SEED_REGISTRY.json",
  "scripts/parity-tiers.ts",
  "scripts/worktree/**",
  "scripts/secrets/**",
  "scripts/{agent-commands,check-workflows,ci-local,github-app-token,parity-remote,parity-service,pr-ready,resolve-issues}.ts",
  "scripts/tsconfig.json",
  "scripts/{github-app-token,resolve-issues}.test.ts",
  ".github/resolve-issues-app.json",
]

/**
 * Paths the consumer smoke does not read, on top of SHARD_IRRELEVANT: it packs the public
 * packages' tarballs (dist, README, package.json), which hold no tests, docs site or guides.
 */
const SMOKE_IRRELEVANT = [...SHARD_IRRELEVANT, "sites/**", "docs/**", "llms.txt", "**/*.test.ts"]

/** Files that cannot change what a live parity run observes, wherever they are. */
const PARITY_IRRELEVANT = ["**/*.md", "**/*.test.ts", "**/tests/**", "**/test/**"]

/**
 * Files outside every package that every service's live parity run reads: how a service is
 * bundled and how the runner drives it. (turbo.json's `globalDependencies` and `bun.lock` are
 * handled separately, and a service's own extras are its `mockingbird.parityInputs`.) Root config,
 * workflows and docs are not here: they do not change what a mock answers, and running every hot
 * service's live parity for them is the load the tiers exist to avoid.
 */
const PARITY_GLOBAL = [
  "scripts/bundle-service.ts",
  "scripts/bundle-service-version.ts",
  "scripts/parity-service.ts",
]

/** turbo.json's `globalDependencies`: they are inputs of every task of every package. */
function turboGlobalDependencies(): string[] {
  const turbo = JSON.parse(readFileSync(join(root, "turbo.json"), "utf8")) as {
    globalDependencies?: string[]
  }
  return turbo.globalDependencies ?? []
}

const matcher = (patterns: string[]) => {
  const globs = patterns.map((p) => new Bun.Glob(p))
  return (file: string) => globs.some((g) => g.match(file))
}

function checkTasks(): { static: string[]; shard: string[] } {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>
  }
  const match = /^turbo run ((?:[\w:-]+ ?)+)$/.exec(pkg.scripts.check ?? "")
  if (!match?.[1]) throw new Error(`package.json "check" is not \`turbo run <tasks…>\``)
  const tasks = match[1].trim().split(/\s+/)

  const turbo = JSON.parse(readFileSync(join(root, "turbo.json"), "utf8")) as {
    tasks: Record<string, unknown>
  }
  const isRoot = (task: string) => `//#${task}` in turbo.tasks
  const split = {
    static: tasks.filter((t) => t === "lint" || isRoot(t)),
    shard: tasks.filter((t) => t !== "lint" && !isRoot(t)),
  }
  if (split.shard.length === 0) throw new Error("no per-package tasks in `check`")
  return split
}

/** Every shard must have a turbo cache the setup action restores, or it always runs cold. */
function assertSetupRestoresEveryShard(): void {
  const action = readFileSync(join(root, ".github/actions/setup/action.yml"), "utf8")
  for (let i = 1; i <= SHARDS; i++) {
    if (!action.includes(`-shard-${i}-`)) {
      throw new Error(`.github/actions/setup/action.yml does not restore shard ${i}'s turbo cache`)
    }
  }
}

/** Hot services whose dependency graph (or `parityInputs`) a PR's changed files reach. */
function hotServicesToRun(
  graph: WorkspaceGraph,
  files: string[] | null,
  reached: Set<string>,
): string[] {
  if (files === null) return []
  return parityServices()
    .filter((service) => service.tier === "hot")
    .filter((service) => {
      const owner = graph.packages.find((p) => p.dir === `packages/service/${service.name}`)
      if (owner && reached.has(owner.name)) return true
      return service.inputs.length > 0 && files.some(matcher(service.inputs))
    })
    .map((service) => service.name)
}

async function changedFiles(base: string): Promise<string[] | null> {
  const range = base === "HEAD^1" ? ["HEAD^1", "HEAD"] : [`${base}...HEAD`]
  const out = await $`git diff --name-only --no-renames ${range}`.cwd(root).nothrow().quiet()
  if (out.exitCode !== 0) return null
  return out.text().split("\n").filter(Boolean)
}

async function changes(args: string[]): Promise<void> {
  checkTasks()
  assertSetupRestoresEveryShard()

  const baseAt = args.indexOf("--base")
  const base = baseAt >= 0 ? args[baseAt + 1] : undefined
  const files = args.includes("--all") || !base ? null : await changedFiles(base)
  if (base && files === null) console.warn(`ci-plan: cannot diff against ${base}; running all`)

  const shardSkippable = matcher(SHARD_IRRELEVANT)
  const smokeSkippable = matcher(SMOKE_IRRELEVANT)
  const parityIgnored = matcher(PARITY_IRRELEVANT)
  const parityGlobal = matcher([...PARITY_GLOBAL, ...turboGlobalDependencies()])

  const graph = await loadGraph()
  const everyPackage = graph.packages.map((p) => p.name)
  const lockfile = base && files ? await lockfileImpactSince(base) : "all"

  // Packages the shards run, and (for hot parity) the packages a parity-relevant change reaches.
  const packages =
    files === null
      ? new Set(everyPackage)
      : affectedPackages(graph, files, {
          ignored: shardSkippable,
          global: () => false,
          unowned: "all",
          lockfile,
        })
  const parityReached =
    files === null
      ? new Set<string>()
      : affectedPackages(graph, files, {
          ignored: parityIgnored,
          global: parityGlobal,
          unowned: "none",
          lockfile,
        })

  // Only hot services run on a PR (each service's tier is in its package.json), and only those
  // whose dependency graph changed. Warm and cold services never run from here.
  const parity = hotServicesToRun(graph, files, parityReached)

  const shards = packages.size > 0
  const smoke = files === null || !files.every(smokeSkippable)
  const shardCount = Math.min(SHARDS, packages.size)

  const outputs = {
    shards: String(shards),
    smoke: String(smoke),
    matrix: JSON.stringify(Array.from({ length: shardCount }, (_, i) => i + 1)),
    packages: JSON.stringify([...packages].sort()),
    parity: parity.join(" "),
  }
  const scope = files === null ? "everything" : `${files.length} changed file(s) vs ${base}`
  const summary = [
    `### CI plan (${scope})`,
    "",
    "| Job | Runs |",
    "| --- | --- |",
    "| Commitlint, Static | always |",
    `| Shards (build, typecheck, test, pack, portability) | ${shards ? `${packages.size} of ${everyPackage.length} packages, on ${shardCount} runner(s)` : "no: nothing they read changed"} |`,
    `| Consumer smoke | ${smoke ? "yes" : "no: no published package changed"} |`,
    `| Live parity (advisory) | ${parity.length > 0 ? parity.join(", ") : "none"} |`,
    "",
  ].join("\n")

  console.log(summary)
  console.log(JSON.stringify(outputs))
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(outputs)
        .map(([k, v]) => `${k}=${v}\n`)
        .join(""),
    )
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
}

async function turbo(args: string[]): Promise<never> {
  console.log(`$ turbo ${args.join(" ")}`)
  const proc = Bun.spawn(["bunx", "turbo", ...args], {
    cwd: root,
    stdio: ["inherit", "inherit", "inherit"],
  })
  process.exit(await proc.exited)
}

async function shard(spec: string | undefined, extra: string[]): Promise<never> {
  const [index, total] = (spec ?? "").split("/").map(Number)
  if (!index || !total || index < 1 || index > total) {
    throw new Error(`usage: bun scripts/ci-plan.ts shard <i>/<n>  (got ${spec})`)
  }
  const listed = JSON.parse(await $`bunx turbo ls --output=json`.cwd(root).quiet().text()) as {
    packages: { items: { name: string; path: string }[] }
  }
  // `changes` hands the affected packages over (AFFECTED_PACKAGES, a JSON array of names); without
  // it, as when run by hand, every package is in scope. Turbo's `dependsOn` still builds whatever
  // an affected package needs, whether or not it is in scope itself.
  const scope = process.env.AFFECTED_PACKAGES
    ? new Set(JSON.parse(process.env.AFFECTED_PACKAGES) as string[])
    : null
  // Round-robin by path: packages cost within a few× of each other, so even counts balance, and
  // each shard restores every shard's cache, so reshuffling on a new package costs no misses.
  const mine = listed.packages.items
    .filter((p) => scope === null || scope.has(p.name))
    .sort((a, b) => a.path.localeCompare(b.path))
    .filter((_, k) => k % total === index - 1)
  console.log(
    `shard ${index}/${total}: ${mine.length} packages\n  ${mine.map((p) => p.path).join("\n  ")}`,
  )
  if (mine.length === 0) process.exit(0)
  return turbo(["run", ...checkTasks().shard, ...mine.map((p) => `--filter=${p.name}`), ...extra])
}

/** Files besides the tarballs whose change can change the consumer smoke's verdict. */
const SMOKE_INPUTS = ["scripts/release/consumer-smoke.ts", "scripts/release/lib.ts"]

/**
 * A fingerprint of everything the consumer smoke installs: each public package's manifest and the
 * `files` it packs (built `dist` included, so run it after the build), plus the smoke script. The
 * smoke job skips when a run with the same fingerprint already passed.
 */
function smokeKey(): void {
  const hasher = new Bun.CryptoHasher("sha256")
  const add = (rel: string) => {
    hasher.update(`${rel}\0`)
    hasher.update(readFileSync(join(root, rel)))
    hasher.update("\0")
  }
  hasher.update(`bun ${Bun.version}\0`)
  for (const rel of SMOKE_INPUTS) add(rel)
  const pkgs = discoverPackages()
    .filter((p) => p.isPublic)
    .sort((a, b) => a.relDir.localeCompare(b.relDir))
  for (const pkg of pkgs) {
    const manifest = JSON.parse(readFileSync(pkg.manifestPath, "utf8")) as { files?: string[] }
    const files = new Set([join(pkg.relDir, "package.json")])
    for (const entry of manifest.files ?? []) {
      const rel = join(pkg.relDir, entry)
      const abs = join(root, rel)
      if (!existsSync(abs)) continue
      if (!statSync(abs).isDirectory()) files.add(rel)
      else for (const f of new Bun.Glob("**/*").scanSync({ cwd: abs })) files.add(join(rel, f))
    }
    for (const rel of [...files].sort()) add(rel)
  }
  console.log(hasher.digest("hex"))
}

const [command, ...rest] = process.argv.slice(2).filter((a) => a !== "--")
switch (command) {
  case "changes":
    await changes(rest)
    break
  case "static":
    await turbo(["run", ...checkTasks().static, ...rest])
    break
  case "shard":
    await shard(rest[0], rest.slice(1))
    break
  case "smoke-key":
    smokeKey()
    break
  default:
    console.error(
      "usage: bun scripts/ci-plan.ts changes [--base <ref> | --all] | static | shard <i>/<n> | smoke-key",
    )
    process.exit(2)
}
