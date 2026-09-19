/**
 * Shared release planning for every public workspace package.
 *
 * Source of truth (same model as semantic-release in the legacy postgres-mem /
 * sqlite-mem repos): versions live in git tags, not in committed package.json
 * files. Each public package is tagged `<name>@<version>` at the commit it was
 * released from; package.json keeps the `0.0.0-development` placeholder.
 *
 * Only mock services (`@crvouga/mockingbird-service-<name>`) are public. The helper
 * packages they build on are private and inlined into each service's bundle
 * (scripts/bundle-service.ts), so a service's sources are its own directory plus
 * every private workspace package its `src` reaches.
 *
 * A package is released when:
 *   - it has never been tagged (initial release), or
 *   - a releasable Conventional Commit touched its sources since its last tag, or
 *   - a public workspace package it depends on at runtime is being released.
 *
 * Bump: BREAKING / `type!` → major, feat → minor, fix/perf/revert/refactor/build/docs → patch,
 * dependency-only release → patch. test/ci/chore/style never release on their own.
 */
import { readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { $ } from "bun"

export const root = join(import.meta.dir, "../..")
export const REPO = "crvouga/mockingbird"
export const WORKFLOW_FILE = "ci.yml"
export const PLACEHOLDER_VERSION = "0.0.0-development"
export const INITIAL_VERSION = "0.1.0"

/** Archived standalone packages superseded by workspace packages. */
export const LEGACY_PACKAGES = [
  {
    name: "@crvouga/postgres-mem",
    repo: "crvouga/postgres-mem",
    replacement: "@crvouga/mockingbird-service-postgres",
  },
  {
    name: "@crvouga/sqlite-mem",
    repo: "crvouga/sqlite-mem",
    replacement: "@crvouga/mockingbird-service-sqlite",
  },
] as const

export const legacyDeprecationMessage = (replacement: string): string =>
  `Moved to ${replacement} (https://github.com/${REPO}). This package is archived and no longer maintained.`

/** Packages once published from this repo whose workspace directory has since been deleted. */
export const REMOVED_PACKAGES = ["@crvouga/mockingbird"] as const

export const RETIRED_DEPRECATION_MESSAGE = `No longer published: Mockingbird now ships only its mock services (@crvouga/mockingbird-service-*), which bundle this code. See https://github.com/${REPO}.`

export type Retired = {
  name: string
  message: string
  /** Deprecate only once this package is on npm, so the message never points at nothing. */
  requires?: string
}

/**
 * npm packages this repo no longer publishes: the archived legacy packages, deleted
 * workspace packages, and every private workspace package (helpers are bundled into the
 * services, never published).
 * Releases deprecate the ones still live on npm; packages never published are skipped.
 */
export function retiredPackages(packages: WorkspacePackage[]): Retired[] {
  return [
    ...LEGACY_PACKAGES.map((l) => ({
      name: l.name,
      message: legacyDeprecationMessage(l.replacement),
      requires: l.replacement,
    })),
    ...[...REMOVED_PACKAGES, ...packages.filter((p) => !p.isPublic).map((p) => p.name)].map(
      (name) => ({ name, message: RETIRED_DEPRECATION_MESSAGE }),
    ),
  ]
}

// ── Workspace discovery ────────────────────────────────────────────

type Manifest = {
  name?: string
  version?: string
  private?: boolean
  publishConfig?: { access?: string }
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

export type WorkspacePackage = {
  name: string
  dir: string
  relDir: string
  manifestPath: string
  isPublic: boolean
  /** Workspace packages this one needs at runtime (dependencies / peer / optional). */
  runtimeDeps: string[]
  /** Directories whose changes release this package: its own plus the private packages it bundles. */
  sourceDirs: string[]
}

const WORKSPACE_IMPORT = /\bfrom\s+["'](@crvouga\/mockingbird(?:-[a-z0-9-]+)?)(?:\/[^"']*)?["']/g

/** Workspace packages imported by a package's shipped `src` (tests excluded). */
function srcImports(dir: string): Set<string> {
  const out = new Set<string>()
  for (const rel of new Bun.Glob("src/**/*.ts").scanSync({ cwd: dir })) {
    if (rel.endsWith(".test.ts")) continue
    for (const m of readFileSync(join(dir, rel), "utf8").matchAll(WORKSPACE_IMPORT)) {
      if (m[1]) out.add(m[1])
    }
  }
  return out
}

export function discoverPackages(): WorkspacePackage[] {
  const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    workspaces: string[]
  }
  const found = new Map<string, Omit<WorkspacePackage, "sourceDirs"> & { deps: string[] }>()
  for (const pattern of rootManifest.workspaces) {
    for (const rel of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: root })) {
      const manifestPath = join(root, rel)
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest
      if (!manifest.name) continue
      const dir = join(manifestPath, "..")
      found.set(manifest.name, {
        name: manifest.name,
        dir,
        relDir: relative(root, dir),
        manifestPath,
        isPublic: manifest.private !== true && manifest.publishConfig?.access === "public",
        runtimeDeps: [],
        deps: Object.keys({
          ...manifest.dependencies,
          ...manifest.peerDependencies,
          ...manifest.optionalDependencies,
        }),
      })
    }
  }
  const isPrivate = (name: string) => found.has(name) && !found.get(name)?.isPublic
  /** Private workspace packages reached from `name`'s src, through their runtime deps. */
  const bundled = (name: string): string[] => {
    const seen = new Set<string>()
    const pkg = found.get(name)
    const queue = pkg ? [...srcImports(pkg.dir)].filter(isPrivate) : []
    for (let next = queue.pop(); next; next = queue.pop()) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(...(found.get(next)?.deps ?? []).filter(isPrivate))
    }
    return [...seen].sort()
  }
  return [...found.values()]
    .map(({ deps, ...pkg }) => ({
      ...pkg,
      runtimeDeps: deps.filter((d) => found.has(d)),
      sourceDirs: pkg.isPublic
        ? [pkg.relDir, ...bundled(pkg.name).map((d) => found.get(d)?.relDir as string)]
        : [pkg.relDir],
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Dependencies before dependents, so every published pin already exists on npm. */
export function topoSort<T extends { name: string; runtimeDeps: string[] }>(pkgs: T[]): T[] {
  const byName = new Map(pkgs.map((p) => [p.name, p]))
  const out: T[] = []
  const state = new Map<string, "visiting" | "done">()
  const visit = (pkg: T) => {
    const s = state.get(pkg.name)
    if (s === "done") return
    if (s === "visiting") throw new Error(`release: dependency cycle through ${pkg.name}`)
    state.set(pkg.name, "visiting")
    for (const dep of pkg.runtimeDeps) {
      const d = byName.get(dep)
      if (d) visit(d)
    }
    state.set(pkg.name, "done")
    out.push(pkg)
  }
  for (const pkg of pkgs) visit(pkg)
  return out
}

// ── Git ────────────────────────────────────────────────────────────

export const tagName = (name: string, version: string): string => `${name}@${version}`

export async function latestTaggedVersion(name: string): Promise<string | null> {
  const result = await $`git tag --list ${`${name}@*`}`.cwd(root).quiet().nothrow()
  const versions = result
    .text()
    .split("\n")
    .map((t) => t.trim().slice(name.length + 1))
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
  if (versions.length === 0) return null
  return versions.sort((a, b) => Bun.semver.order(b, a))[0] ?? null
}

export type Commit = { hash: string; subject: string; body: string }

/** Non-merge commits since `tag` that touched any of `dirs` (PR commits are commitlint-enforced). */
export async function commitsTouching(tag: string, dirs: string[]): Promise<Commit[]> {
  const sep = "\u001e"
  const result =
    await $`git log --no-merges ${`--format=%H%x1f%s%x1f%b${sep}`} ${`${tag}..HEAD`} -- ${dirs}`
      .cwd(root)
      .quiet()
  return result
    .text()
    .split(sep)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const [hash = "", subject = "", body = ""] = block.split("\u001f")
      return { hash: hash.trim(), subject: subject.trim(), body: body.trim() }
    })
}

// ── Conventional Commits ───────────────────────────────────────────

export type Bump = "major" | "minor" | "patch"
const ORDER: Bump[] = ["patch", "minor", "major"]
const PATCH_TYPES = new Set(["fix", "perf", "revert", "refactor", "build", "docs"])
const HEADER = /^(\w+)(\([^)]*\))?(!)?:\s*(.*)$/

export function parseCommit(commit: Commit): { type: string | null; bump: Bump | null } {
  const m = commit.subject.match(HEADER)
  const type = m?.[1] ?? null
  if (m?.[3] === "!" || /^BREAKING[ -]CHANGE:/m.test(commit.body)) return { type, bump: "major" }
  if (type === "feat") return { type, bump: "minor" }
  if (type && PATCH_TYPES.has(type)) return { type, bump: "patch" }
  return { type, bump: null }
}

export const stripType = (subject: string): string => subject.match(HEADER)?.[4] ?? subject

export function maxBump(bumps: (Bump | null)[]): Bump | null {
  let best: Bump | null = null
  for (const b of bumps) if (b && (!best || ORDER.indexOf(b) > ORDER.indexOf(best))) best = b
  return best
}

export function bumpVersion(version: string, bump: Bump): string {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number)
  if (bump === "major") return `${major + 1}.0.0`
  if (bump === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

// ── npm ────────────────────────────────────────────────────────────

/** Published versions, `[]` if the package does not exist, or an error string. */
export async function npmVersions(name: string): Promise<string[] | { error: string }> {
  const result = await $`npm view ${name} versions --json`.cwd(root).quiet().nothrow()
  const out = result.stdout.toString().trim()
  if (result.exitCode !== 0) {
    if (/E404|404 Not Found/.test(out + result.stderr.toString())) return []
    return { error: result.stderr.toString().trim() || `npm view exited ${result.exitCode}` }
  }
  if (!out) return []
  const parsed = JSON.parse(out) as string | string[]
  return Array.isArray(parsed) ? parsed : [parsed]
}

export function redact(text: string): string {
  return text
    .replace(/npm_[A-Za-z0-9]{20,}/g, "npm_***")
    .replace(/_authToken=\S+/g, "_authToken=***")
}

// ── Plan ───────────────────────────────────────────────────────────

export type Release = {
  pkg: WorkspacePackage
  previous: string | null
  version: string
  bump: Bump | "initial"
  commits: Commit[]
  /** Workspace dependencies released in the same run. */
  dependencyUpdates: string[]
}

export type Plan = {
  packages: WorkspacePackage[]
  /** Version every public package resolves to after this run (released or last tag). */
  versions: Map<string, string>
  releases: Release[]
}

export async function computePlan(): Promise<Plan> {
  const packages = discoverPackages()
  const publicPkgs = packages.filter((p) => p.isPublic)
  const versions = new Map<string, string>()
  const releases = new Map<string, Release>()

  for (const pkg of publicPkgs) {
    const previous = await latestTaggedVersion(pkg.name)
    if (!previous) {
      // Never tagged: first release. If npm already has versions (e.g. a manual
      // seed), release the next patch above them so provenance builds win.
      const published = await npmVersions(pkg.name)
      if (!Array.isArray(published)) throw new Error(`npm view ${pkg.name}: ${published.error}`)
      const latest = published.sort((a, b) => Bun.semver.order(b, a))[0]
      const version = latest ? bumpVersion(latest, "patch") : INITIAL_VERSION
      releases.set(pkg.name, {
        pkg,
        previous: null,
        version,
        bump: "initial",
        commits: [],
        dependencyUpdates: [],
      })
      continue
    }
    versions.set(pkg.name, previous)
    const commits = await commitsTouching(tagName(pkg.name, previous), pkg.sourceDirs)
    const bump = maxBump(commits.map((c) => parseCommit(c).bump))
    if (bump) {
      releases.set(pkg.name, {
        pkg,
        previous,
        version: bumpVersion(previous, bump),
        bump,
        commits: commits.filter((c) => parseCommit(c).bump),
        dependencyUpdates: [],
      })
    }
  }

  // Workspace deps are pinned exactly at pack time, so dependents must re-release.
  let changed = true
  while (changed) {
    changed = false
    for (const pkg of publicPkgs) {
      const updated = pkg.runtimeDeps.filter((d) => releases.has(d))
      if (updated.length === 0) continue
      const existing = releases.get(pkg.name)
      if (existing) {
        existing.dependencyUpdates = updated
        continue
      }
      const previous = versions.get(pkg.name)
      if (!previous) continue
      releases.set(pkg.name, {
        pkg,
        previous,
        version: bumpVersion(previous, "patch"),
        bump: "patch",
        commits: [],
        dependencyUpdates: updated,
      })
      changed = true
    }
  }

  for (const r of releases.values()) versions.set(r.pkg.name, r.version)
  const ordered = topoSort(publicPkgs).filter((p) => releases.has(p.name))
  return {
    packages,
    versions,
    releases: ordered.map((p) => releases.get(p.name) as Release),
  }
}

export function releaseNotes(release: Release, versions: Map<string, string>): string {
  const lines: string[] = []
  const link = (c: Commit) =>
    `- ${stripType(c.subject)} ([${c.hash.slice(0, 7)}](https://github.com/${REPO}/commit/${c.hash}))`
  if (release.bump === "initial") lines.push("Initial release.", "")
  const sections: [string, (c: Commit) => boolean][] = [
    ["⚠️ Breaking changes", (c) => parseCommit(c).bump === "major"],
    ["Features", (c) => parseCommit(c).bump === "minor"],
    ["Fixes and improvements", (c) => parseCommit(c).bump === "patch"],
  ]
  for (const [title, match] of sections) {
    const matched = release.commits.filter(match)
    if (matched.length === 0) continue
    lines.push(`### ${title}`, "", ...matched.map(link), "")
  }
  if (release.dependencyUpdates.length > 0) {
    lines.push(
      "### Dependencies",
      "",
      ...release.dependencyUpdates.map((d) => `- \`${d}@${versions.get(d)}\``),
      "",
    )
  }
  const pkgUrl = `https://www.npmjs.com/package/${release.pkg.name}/v/${release.version}`
  lines.push(`npm: [${release.pkg.name}@${release.version}](${pkgUrl})`)
  return lines.join("\n")
}
