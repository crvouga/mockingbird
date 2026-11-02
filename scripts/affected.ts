/**
 * Which workspace packages a change reaches, through the dependency graph Turborepo already holds
 * (`turbo query`: every package's transitive workspace dependencies, from the package.json
 * `dependencies`, `devDependencies` and peers). scripts/ci-plan.ts uses it to scope a pull request:
 * a package is affected when a file in it or in anything it depends on changed, so a change to
 * mock A never reaches mock B, and a change to a shared package reaches every dependent.
 *
 * A package is also affected when a file it declares as a turbo task input outside its own
 * directory (`$TURBO_ROOT$/…`) changed: those inputs are how a task says it reads another
 * package's files, and turbo re-runs it for them, so the plan must schedule it too.
 *
 * Files that belong to no package (root config, scripts) are the caller's call, and `bun.lock` is
 * read here: Turborepo does not diff bun's lockfile, so `lockfileImpact` does.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { $ } from "bun"

const root = join(import.meta.dir, "..")

/** One task's inputs outside its package, as repo-relative globs. */
export interface ExternalInputs {
  include: string[]
  exclude: string[]
  /**
   * Whether dependents consume this task's result (some task depends on `^<task>`, like `build`).
   * When not (a `test` input), a change reaches the package but not what depends on it.
   */
  upstream: boolean
}

export interface WorkspaceGraph {
  packages: { name: string; dir: string; dependencies: string[]; inputs?: ExternalInputs[] }[]
}

interface TurboConfig {
  tasks?: Record<string, { inputs?: string[]; dependsOn?: string[] }>
}

const ROOT_PREFIX = "$TURBO_ROOT$/"

/**
 * The `$TURBO_ROOT$/…` inputs of each task `name` runs (one with a script in its package.json),
 * resolved the way turbo does: `<name>#<task>` in the root turbo.json, else the package's own
 * turbo.json, else the root task (`$TURBO_EXTENDS$` adds the root's inputs back).
 * Package-relative globs stay out: they cannot match a file outside the package.
 */
export function externalInputs(
  name: string,
  scripts: Record<string, string>,
  rootTurbo: TurboConfig,
  pkgTurbo: TurboConfig = {},
): ExternalInputs[] {
  const upstream = new Set(
    [rootTurbo, pkgTurbo]
      .flatMap((config) => Object.values(config.tasks ?? {}))
      .flatMap((task) => task.dependsOn ?? [])
      .filter((dep) => dep.startsWith("^"))
      .map((dep) => dep.slice(1)),
  )
  const out: ExternalInputs[] = []
  for (const task of Object.keys(scripts)) {
    const base = rootTurbo.tasks?.[task]?.inputs ?? []
    const own = rootTurbo.tasks?.[`${name}#${task}`]?.inputs ?? pkgTurbo.tasks?.[task]?.inputs
    const inputs = own ? (own.includes("$TURBO_EXTENDS$") ? [...base, ...own] : own) : base
    const include: string[] = []
    const exclude: string[] = []
    for (const input of inputs) {
      const negated = input.startsWith("!")
      const glob = negated ? input.slice(1) : input
      if (!glob.startsWith(ROOT_PREFIX)) continue
      ;(negated ? exclude : include).push(glob.slice(ROOT_PREFIX.length))
    }
    if (include.length > 0) out.push({ include, exclude, upstream: upstream.has(task) })
  }
  return out
}

/** Whether `file` is one of a task's external inputs (matched by an include, no exclude). */
export function matchesInputs(inputs: ExternalInputs, file: string): boolean {
  const hit = (globs: string[]) => globs.some((g) => new Bun.Glob(g).match(file))
  return hit(inputs.include) && !hit(inputs.exclude)
}

/** {@link externalInputs} for the package in `dir`, read from the repo. */
export function readExternalInputs(dir: string): ExternalInputs[] {
  const json = <T>(path: string, fallback: T): T =>
    existsSync(path) ? (Bun.JSONC.parse(readFileSync(path, "utf8")) as T) : fallback
  const manifest = json<{ name?: string; scripts?: Record<string, string> }>(
    join(root, dir, "package.json"),
    {},
  )
  return externalInputs(
    manifest.name ?? "",
    manifest.scripts ?? {},
    json<TurboConfig>(join(root, "turbo.json"), {}),
    json<TurboConfig>(join(root, dir, "turbo.json"), {}),
  )
}

/** The graph from `turbo query`, with the same turbo version the repo pins (no install needed). */
export async function loadGraph(): Promise<WorkspaceGraph> {
  const manifest = JSON.parse(await Bun.file(join(root, "package.json")).text()) as {
    devDependencies: Record<string, string>
  }
  const turbo = `turbo@${manifest.devDependencies.turbo}`
  const out =
    await $`bunx ${turbo} query ${"{ packages { items { name path allDependencies { items { name } } } } }"}`
      .cwd(root)
      .quiet()
      .text()
  const { data } = JSON.parse(out.slice(out.indexOf("{"))) as {
    data: {
      packages: {
        items: { name: string; path: string; allDependencies: { items: { name: string }[] } }[]
      }
    }
  }
  // Turbo lists the root workspace as "//" and makes every package depend on it; root files are
  // handled by the caller, not by the graph.
  return {
    packages: data.packages.items
      .filter((p) => p.name !== "//")
      .map((p) => ({
        name: p.name,
        dir: p.path,
        dependencies: p.allDependencies.items.map((d) => d.name).filter((n) => n !== "//"),
        inputs: readExternalInputs(p.path),
      })),
  }
}

/** The package a file belongs to (the deepest package directory containing it), if any. */
export function packageOf(graph: WorkspaceGraph, file: string): string | undefined {
  let best: { name: string; dir: string } | undefined
  for (const p of graph.packages) {
    if (file.startsWith(`${p.dir}/`) && (!best || p.dir.length > best.dir.length)) best = p
  }
  return best?.name
}

/** `names` and every package that depends on any of them, directly or transitively. */
export function withDependents(graph: WorkspaceGraph, names: Iterable<string>): Set<string> {
  const changed = new Set(names)
  return new Set(
    graph.packages
      .filter((p) => changed.has(p.name) || p.dependencies.some((d) => changed.has(d)))
      .map((p) => p.name),
  )
}

export type LockfileImpact = "none" | "all" | { workspaces: string[] }

interface Lockfile {
  workspaces: Record<string, unknown>
  packages: Record<string, unknown[]>
  [key: string]: unknown
}

/**
 * What a `bun.lock` change touches. If anything but workspace entries moved (an external package's
 * resolved version or hash, overrides, trusted dependencies), it can reach any package: "all".
 * Otherwise only the workspaces whose own entry changed (a dependency added to one package, or a
 * new package): their directories, and the root entry (`""`) counts as "all". A whitespace-only
 * change is "none".
 */
export function lockfileImpact(baseText: string, headText: string): LockfileImpact {
  if (baseText === headText) return "none"
  const parse = (text: string) => Bun.JSONC.parse(text) as Lockfile
  const base = parse(baseText)
  const head = parse(headText)
  const split = (lock: Lockfile) => {
    const { workspaces, packages, ...rest } = lock
    const external = Object.entries(packages ?? {}).filter(
      ([, entry]) => !String(entry[0]).includes("@workspace:"),
    )
    return { workspaces: workspaces ?? {}, shared: JSON.stringify([rest, external]) }
  }
  const a = split(base)
  const b = split(head)
  if (a.shared !== b.shared) return "all"
  const dirs = Object.keys({ ...a.workspaces, ...b.workspaces }).filter(
    (dir) => JSON.stringify(a.workspaces[dir]) !== JSON.stringify(b.workspaces[dir]),
  )
  if (dirs.includes("")) return "all"
  return dirs.length === 0 ? "none" : { workspaces: dirs }
}

export interface ScopeRules {
  /** Files that reach nothing: not read by whatever this scope is for. */
  ignored: (file: string) => boolean
  /** Files outside every package that reach every package (e.g. a turbo global dependency). */
  global: (file: string) => boolean
  /** What a file outside every package (and not `global`) reaches: every package, or none. */
  unowned: "all" | "none"
  /** What `bun.lock` changed, when it is among the files. */
  lockfile: LockfileImpact
  /** Whether a package's `$TURBO_ROOT$/…` task inputs reach it (see {@link externalInputs}). */
  externalInputs: boolean
}

/**
 * The packages a set of changed files reaches: each file's own package, each package declaring it
 * as an external input, every package that depends on one of those (through a task dependents
 * consume, for external inputs), and every package when a file reaches all of them.
 */
export function affectedPackages(
  graph: WorkspaceGraph,
  files: string[],
  rules: ScopeRules,
): Set<string> {
  const every = () => new Set(graph.packages.map((p) => p.name))
  const touched = new Set<string>()
  // Packages reached through a task their dependents do not consume (a test reading a fixture).
  const alone = new Set<string>()
  for (const file of files) {
    if (rules.ignored(file)) continue
    if (file === "bun.lock") {
      if (rules.lockfile === "all") return every()
      if (rules.lockfile !== "none") {
        for (const dir of rules.lockfile.workspaces) {
          const owner = graph.packages.find((p) => p.dir === dir)
          if (owner) touched.add(owner.name)
        }
      }
      continue
    }
    for (const p of rules.externalInputs ? graph.packages : []) {
      const hits = (p.inputs ?? []).filter((i) => matchesInputs(i, file))
      if (hits.some((i) => i.upstream)) touched.add(p.name)
      else if (hits.length > 0) alone.add(p.name)
    }
    const owner = packageOf(graph, file)
    if (owner && !rules.global(file)) touched.add(owner)
    else if (rules.global(file) || rules.unowned === "all") return every()
  }
  return new Set([...withDependents(graph, touched), ...alone])
}

/** `bun.lock` at `base` (the merge base with HEAD) against the working tree's, when it changed. */
export async function lockfileImpactSince(base: string): Promise<LockfileImpact> {
  const mergeBase = (await $`git merge-base ${base} HEAD`.cwd(root).nothrow().quiet().text()).trim()
  const before = await $`git show ${`${mergeBase || base}:bun.lock`}`.cwd(root).nothrow().quiet()
  if (before.exitCode !== 0) return "all"
  try {
    return lockfileImpact(before.text(), await Bun.file(join(root, "bun.lock")).text())
  } catch {
    return "all"
  }
}
