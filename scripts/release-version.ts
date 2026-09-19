/**
 * Automatic semantic version bump from conventional commits.
 *
 *   --check   Analyse commits since last tag, print version info, exit 0.
 *             Output: has_changes=true|false, version=, bump=
 *   --bump    Bump all public package.json versions, git commit + tag.
 *
 * Commit ranges: `git describe --tags --abbrev=0 --match 'v*'` → HEAD.
 * No prior tag = all commits since root.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { $ } from "bun"

const root = join(import.meta.dir, "..")
const argv = process.argv.slice(2)
const isCheck = argv.includes("--check")
const isBump = argv.includes("--bump")

// ── Git helpers ────────────────────────────────────────────────────

async function lastTag(): Promise<string | null> {
  const result = await $`git describe --tags --abbrev=0 --match 'v*'`.cwd(root).quiet().nothrow()
  return result.exitCode === 0 ? result.text().trim() : null
}

type Commit = { hash: string; subject: string; body: string }

async function commitsSince(ref: string | null): Promise<Commit[]> {
  const range = ref ? `${ref}..HEAD` : "--root"
  const result = await $`git log --first-parent ${range} --format='%H|||%s|||%b---'`
    .cwd(root)
    .quiet()
  if (result.exitCode !== 0) return []
  const raw = result.text().trim()
  if (!raw) return []
  return raw
    .split("---\n")
    .filter(Boolean)
    .map((block) => {
      const [hash, subject, ...bodyLines] = block.split("|||")
      return {
        hash: (hash ?? "").trim(),
        subject: (subject ?? "").trim(),
        body: (bodyLines ?? []).join("\n").trim(),
      }
    })
}

const Bump = { major: "major", minor: "minor", patch: "patch" } as const
type Bump = (typeof Bump)[keyof typeof Bump]

const ORDER: Bump[] = [Bump.patch, Bump.minor, Bump.major]

function parseBump(subject: string, body: string): Bump | null {
  // BREAKING CHANGE in body
  if (/^BREAKING(\s+CHANGE)?:/m.test(body)) return Bump.major
  // Extract type from first line
  const m = subject.match(
    /^(build|chore|ci|docs|feat|fix|perf|refactor|style|test)(\([^)]+\))?(!)?:/,
  )
  if (!m) return null
  const type = m[1]
  if (!type) return null
  const breaking = m[3] === "!"
  if (breaking) return Bump.major
  if (type === "feat") return Bump.minor
  if (type === "fix") return Bump.patch
  return null
}

function maxBump(types: (Bump | null)[]): Bump | null {
  let result: Bump | null = null
  for (const t of types) {
    if (t && (!result || ORDER.indexOf(t) > ORDER.indexOf(result))) {
      result = t
    }
  }
  return result
}

// ── Version helpers ────────────────────────────────────────────────

function bumpVersion(current: string, bump: Bump): string {
  const parts = current.split(".").map(Number)
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    console.error(`release-version: cannot parse version "${current}"`)
    process.exit(1)
  }
  const [major, minor, patch] = parts as [number, number, number]
  switch (bump) {
    case "major":
      return `${major + 1}.0.0`
    case "minor":
      return `${major}.${minor + 1}.0`
    case "patch":
      return `${major}.${minor}.${patch + 1}`
  }
}

// ── Package discovery ──────────────────────────────────────────────

type PkgInfo = { dir: string; name: string; version: string; path: string }

function collectPublicPackages(): PkgInfo[] {
  const out: PkgInfo[] = []
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const child = join(dir, entry.name)
      const pkgPath = join(child, "package.json")
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
          name?: string
          version?: string
          private?: boolean
          publishConfig?: { access?: string }
        }
        if (
          pkg.name &&
          pkg.version &&
          pkg.private !== true &&
          pkg.publishConfig?.access === "public"
        ) {
          out.push({
            dir: child,
            name: pkg.name,
            version: pkg.version,
            path: pkgPath,
          })
        }
      } else {
        walk(child)
      }
    }
  }
  walk(join(root, "packages"))
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// ── Main ───────────────────────────────────────────────────────────

const tag = await lastTag()
const commits = await commitsSince(tag)

const bumps = commits.map((c) => parseBump(c.subject, c.body))
const highest = maxBump(bumps)

const facadePkg = join(root, "packages/facade/package.json")
const currentVersion = JSON.parse(readFileSync(facadePkg, "utf8")).version as string

if (isCheck) {
  if (!highest) {
    console.log("has_changes=false")
    process.exit(0)
  }
  const next = bumpVersion(currentVersion, highest)
  console.log(`version=${next} bump=${highest} has_changes=true`)
  process.exit(0)
}

if (isBump) {
  if (!highest) {
    console.log("release-version: no semantic changes since last tag — nothing to bump")
    process.exit(0)
  }

  const next = bumpVersion(currentVersion, highest)
  const packages = collectPublicPackages()

  // Bump every public package
  let changed = 0
  for (const pkg of packages) {
    const raw = readFileSync(pkg.path, "utf8")
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed.version !== currentVersion) continue
    const updated = raw.replace(`"version": "${currentVersion}"`, `"version": "${next}"`)
    writeFileSync(pkg.path, updated, "utf8")
    changed++
  }

  // Also bump root package.json (monorepo version, not published but tracked)
  const rootPkgPath = join(root, "package.json")
  const rootRaw = readFileSync(rootPkgPath, "utf8")
  const rootParsed = JSON.parse(rootRaw) as Record<string, unknown>
  if (rootParsed.version === currentVersion) {
    writeFileSync(
      rootPkgPath,
      rootRaw.replace(`"version": "${currentVersion}"`, `"version": "${next}"`),
      "utf8",
    )
  }

  console.log(
    `release-version: bumped ${changed} public packages from ${currentVersion} to ${next}`,
  )

  // Git operations
  const changedFiles: string[] = [rootPkgPath, ...packages.map((p) => p.path)]
  const changedSet = new Set(changedFiles.filter((p) => existsSync(p)))

  await $`git add ${[...changedSet]}`.cwd(root)
  await $`git commit -m ${`chore(release): v${next} [skip ci]`}`.cwd(root)
  await $`git tag -a ${`v${next}`} -m ${`v${next}`}`.cwd(root)

  console.log(`release-version: committed and tagged v${next} [skip ci]`)
  process.exit(0)
}

// No flag — same as --check
if (!highest) {
  console.log("has_changes=false")
  process.exit(0)
}
const next = bumpVersion(currentVersion, highest)
console.log(`version=${next} bump=${highest} has_changes=true`)
