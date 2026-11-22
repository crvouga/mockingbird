/**
 * The paths scripts/ci-plan.ts lets a pull request skip the shards for, and the check that no
 * shard task declares one of them as a turbo input.
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

const root = join(import.meta.dir, "..")

/**
 * Paths no shard task reads: not a package input, not a turbo global dependency, not a build
 * script. A change made only of these skips the shards (and the consumer smoke). The one exception
 * is a task in HASH_ONLY_READERS, and `assertShardIrrelevantUnread` fails on any other.
 */
export const SHARD_IRRELEVANT = [
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
 * Tasks that declare SHARD_IRRELEVANT paths as turbo inputs but only hash their bytes and never
 * run them. Skipping such a task cannot hide a failure, and `main` runs every task on push.
 */
export const HASH_ONLY_READERS: Record<string, string> = {
  "@crvouga/mockingbird-docs#build":
    "hashes every scripts/** file into /health.json's source fingerprint (sites/docs/src/lib/deployment.ts) and imports none of them",
}

/** A task's `$TURBO_ROOT$/…` inputs, relative to the repo root. */
export interface RootInputs {
  task: string
  include: string[]
  exclude: string[]
}

type TurboTasks = { globalDependencies?: string[]; tasks?: Record<string, { inputs?: string[] }> }

const ROOT_PREFIX = "$TURBO_ROOT$/"

function rootInputsOf(task: string, inputs: string[]): RootInputs {
  const include: string[] = []
  const exclude: string[] = []
  for (const input of inputs) {
    if (input.startsWith(ROOT_PREFIX)) include.push(input.slice(ROOT_PREFIX.length))
    else if (input.startsWith(`!${ROOT_PREFIX}`)) exclude.push(input.slice(ROOT_PREFIX.length + 1))
  }
  return { task, include, exclude }
}

/**
 * Every shard task's inputs outside its own package: the root turbo.json's per-package tasks
 * (`//#…` root tasks run in the static job, which always runs) and global dependencies, and each
 * package turbo.json's tasks, as `<package>#<task>`.
 */
export function shardRootInputs(repo = root, turboFiles = turboConfigs(repo)): RootInputs[] {
  const out: RootInputs[] = []
  for (const file of turboFiles) {
    const config = JSON.parse(readFileSync(join(repo, file), "utf8")) as TurboTasks
    const dir = dirname(file)
    if (dir === ".") {
      out.push({
        task: "globalDependencies",
        include: config.globalDependencies ?? [],
        exclude: [],
      })
    }
    const pkg =
      dir === "."
        ? ""
        : (JSON.parse(readFileSync(join(repo, dir, "package.json"), "utf8")) as { name: string })
            .name
    for (const [name, task] of Object.entries(config.tasks ?? {})) {
      if (name.startsWith("//#")) continue
      out.push(rootInputsOf(pkg ? `${pkg}#${name}` : name, task.inputs ?? []))
    }
  }
  return out
}

function turboConfigs(repo: string): string[] {
  const listed = Bun.spawnSync(["git", "ls-files", "turbo.json", "**/turbo.json"], { cwd: repo })
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`)
  return listed.stdout
    .toString()
    .split("\n")
    .filter((f) => f && existsSync(join(repo, f)))
}

const matches = (patterns: string[]) => {
  const globs = patterns.map((p) => new Bun.Glob(p))
  return (file: string) => globs.some((g) => g.match(file))
}

/** SHARD_IRRELEVANT files a shard task declares as an input, other than HASH_ONLY_READERS. */
export function shardIrrelevantReads(
  files: string[],
  inputs: RootInputs[],
  skippable = SHARD_IRRELEVANT,
  hashOnly: Record<string, string> = HASH_ONLY_READERS,
): { file: string; task: string }[] {
  const isSkippable = matches(skippable)
  const reads: { file: string; task: string }[] = []
  for (const input of inputs) {
    if (input.task in hashOnly) continue
    const included = matches(input.include)
    const excluded = matches(input.exclude)
    for (const file of files) {
      if (isSkippable(file) && included(file) && !excluded(file)) {
        reads.push({ file, task: input.task })
      }
    }
  }
  return reads
}

/** Throws when a tracked SHARD_IRRELEVANT file is an input of a shard task. */
export function assertShardIrrelevantUnread(repo = root): void {
  const listed = Bun.spawnSync(["git", "ls-files"], { cwd: repo })
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`)
  const files = listed.stdout.toString().split("\n").filter(Boolean)
  const reads = shardIrrelevantReads(files, shardRootInputs(repo))
  if (reads.length === 0) return
  const list = reads.map(({ file, task }) => `  ${file} (input of ${task})`).join("\n")
  throw new Error(
    `scripts/ci-paths.ts SHARD_IRRELEVANT lists paths a shard task reads, so a change to only them skips that task:\n${list}\nRemove them from SHARD_IRRELEVANT, or add the task to HASH_ONLY_READERS if it never runs them.`,
  )
}
