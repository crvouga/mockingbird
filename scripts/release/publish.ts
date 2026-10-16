/**
 * Release every public package that changed since its last `<name>@<version>` tag.
 *
 * For each release (dependencies first):
 *   1. pack with `bun pm pack` (rewrites `workspace:*` to the exact released versions)
 *   2. npm publish — Trusted Publishing (OIDC) in CI; an interactive maintainer login only
 *      for a brand-new package during `release:seed`
 *   3. push the `<name>@<version>` tag and create its GitHub Release
 * A local seed also attaches the Trusted Publisher to every published service that lacks one,
 * and deprecates every package this repo no longer publishes. CI has no long-lived npm
 * credential and can perform neither account-management operation.
 *
 * Every step is idempotent: versions already on npm, existing tags and existing
 * GitHub Releases are skipped, so a failed run is fixed by re-running it.
 * A GitHub 500 while creating a release is retried. It does not abort the other
 * packages, and a tag that already exists is not published again.
 *
 *   bun run release:publish -- --dry-run   (plan + pack, no side effects)
 *   bun run release:publish                (CI, on main)
 *   bun run release:publish -- --local     (maintainer bootstrap: your npm login, no provenance)
 *   bun run release:seed -- --trust-only   (repair and verify published packages' OIDC setup)
 *   bun run release:publish -- --plan release-plan.json --group 1/8 (one CI leaf shard)
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { $ } from "bun"
import { VERSION_PLACEHOLDER } from "../bundle-service-version.ts"
import { loadPackageTrust, npmAuthToken, type PackageTrust } from "../health/trusted-publisher.ts"
import { alertIfWaiting } from "./attention.ts"
import { restoreOriginals } from "./files.ts"
import {
  changelog,
  computePlan,
  discoverPackages,
  githubRetryDelayMs,
  initialPackageBlocker,
  isRetryableGitHubError,
  npmVersions,
  type Plan,
  packedManifest,
  pinManifest,
  REPO,
  type Release,
  redact,
  releaseInOrder,
  releaseNotes,
  retiredPackages,
  root,
  seedSummary,
  tagName,
  unresolvablePins,
  WORKFLOW_FILE,
} from "./lib.ts"
import { pipelineOptions, readPlan, selectReleases } from "./pipeline.ts"
import { rejectedReleasePackages } from "./rejected.ts"
import { trustedPublisherReconciler } from "./trust.ts"

const argv = process.argv.slice(2)
const dryRun = argv.includes("--dry-run")
const local = argv.includes("--local")
const trustOnly = argv.includes("--trust-only")
const refreshRejected = argv.includes("--refresh-rejected")
if (refreshRejected && !trustOnly) throw new Error("--refresh-rejected requires --trust-only")
const inCi = process.env.GITHUB_ACTIONS === "true"
const pipeline = pipelineOptions(argv)
if (pipeline && (local || trustOnly))
  throw new Error("release groups cannot be used with local seeding")
const maintenance = !pipeline || pipeline.group === "maintenance"

if (trustOnly && !local) {
  console.error("--trust-only requires --local. Use bun run release:seed -- --trust-only.")
  process.exit(1)
}

if (!dryRun && !inCi && !local) {
  console.error("release:publish: runs in CI. Use --dry-run to preview, or --local to bootstrap.")
  process.exit(1)
}

if (local && !dryRun && !trustOnly) {
  await $`git fetch origin main --tags`.cwd(root).quiet()
  const head = (await $`git rev-parse HEAD`.cwd(root).quiet()).text().trim()
  const main = (await $`git rev-parse origin/main`.cwd(root).quiet()).text().trim()
  if (head !== main) {
    console.error("release:publish --local must run from a checkout of origin/main")
    process.exit(1)
  }
}

const plan: Plan = trustOnly
  ? { packages: discoverPackages(), releases: [], versions: new Map() }
  : pipeline
    ? await readPlan(pipeline.path)
    : await computePlan()
if (pipeline) {
  plan.releases = selectReleases(plan, pipeline.group)
  if (maintenance) plan.versions.clear()
}
if (trustOnly) {
  console.log("release:publish: reconciling Trusted Publishers only")
} else if (plan.releases.length === 0) {
  console.log("release:publish: nothing to release")
} else {
  console.log(
    `release:publish: ${plan.releases.length} package(s) still to release${dryRun ? " (dry-run)" : ""}`,
  )
}

// Pin every public package for packing: its own version, and its workspace
// dependencies rewritten to the versions this run resolves them to.
const originals = new Map<string, string>()
for (const pkg of plan.packages) {
  const version = plan.versions.get(pkg.name)
  if (!version) continue
  const raw = readFileSync(pkg.manifestPath, "utf8")
  originals.set(pkg.manifestPath, raw)
  writeFileSync(pkg.manifestPath, pinManifest(raw, version, plan.versions))
  // Bundles carry VERSION_PLACEHOLDER (scripts/bundle-service.ts) where the service reports
  // its version, e.g. the `x-mockingbird` header; stamp the version being published.
  const dist = join(pkg.dir, "dist")
  if (!existsSync(dist)) continue
  for (const file of readdirSync(dist, { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".js")) continue
    const path = join(dist, file)
    const code = readFileSync(path, "utf8")
    const placeholder = JSON.stringify(VERSION_PLACEHOLDER)
    if (!code.includes(placeholder)) continue
    originals.set(path, code)
    writeFileSync(path, code.replaceAll(placeholder, JSON.stringify(version)))
  }
}

// Each release ships its whole changelog, generated from the tags; removed after packing.
const changelogs: string[] = []
for (const release of plan.releases) {
  const path = join(release.pkg.dir, "CHANGELOG.md")
  if (existsSync(path)) originals.set(path, readFileSync(path, "utf8"))
  writeFileSync(path, await changelog(release.pkg, release))
  changelogs.push(path)
}

const packDir = mkdtempSync(join(tmpdir(), "mockingbird-release-"))
const failed = new Set<string>()
/** Never-published packages that need the interactive local seed. */
const needsSeed: string[] = []
/** Published packages whose OIDC publish npm rejected; the local seed attaches their publisher. */
const needsTrust: string[] = []
/** Pins already published or verified on npm; avoid checking shared prerequisites per package. */
const releasedNow = new Set<string>()
// OIDC is npm's fallback only when legacy token auth is absent. Locally, use the npm login.
const npmEnv: Record<string, string | undefined> = { ...process.env }
if (!local) delete npmEnv.NODE_AUTH_TOKEN
const localTrustToken = local && !dryRun ? npmAuthToken() : undefined
const refreshPublishers = refreshRejected
  ? await rejectedReleasePackages(
      new Set(plan.packages.filter((pkg) => pkg.isPublic).map((pkg) => pkg.name)),
    )
  : new Set<string>()
if (refreshRejected) {
  console.log(
    `release:publish: refreshing ${refreshPublishers.size} publisher(s) rejected by the latest Release`,
  )
}
const trustPackages = plan.packages.filter(
  (pkg) => pkg.isPublic && (!refreshRejected || refreshPublishers.has(pkg.name)),
)

/** A seed is left running unattended, so a step that stalls on the maintainer's approval alerts. */
function attended<T>(what: string, work: () => Promise<T>): Promise<T> {
  if (!local) return work()
  return alertIfWaiting(
    `${what} is probably waiting for your npm approval (2FA) in this terminal or your browser`,
    work,
  )
}

/** Runs npm with inherited stdio so a local run can answer 2FA prompts. */
async function npm(args: string[], cwd = root): Promise<number> {
  const proc = Bun.spawn(["npm", ...args], {
    cwd,
    env: npmEnv,
    stdio: ["inherit", "inherit", "inherit"],
  })
  return await attended(`npm ${args[0]}`, () => proc.exited)
}

function fail(name: string, lines: string[]): void {
  failed.add(name)
  console.error(`::error::release ${name} failed`)
  for (const line of lines) console.error(`  ${redact(line)}`)
}

/**
 * A consumer runs `npm i <pkg>` with no overrides, so every workspace pin in the
 * packed manifest has to be a real version that npm can already serve. Releases are
 * topologically ordered, so a dependency released in this same run is there first.
 */
async function assertInstallable(release: Release, tarball: string): Promise<boolean> {
  const manifest = await packedManifest(tarball)
  const bad = unresolvablePins(manifest)
  if (bad.length > 0) {
    fail(release.pkg.name, ["packed manifest pins no consumer could resolve:", ...bad])
    return false
  }
  for (const dep of release.pkg.runtimeDeps) {
    const pinned =
      manifest.dependencies?.[dep] ??
      manifest.peerDependencies?.[dep] ??
      manifest.optionalDependencies?.[dep]
    if (!pinned || releasedNow.has(`${dep}@${pinned}`)) continue
    const published = await npmVersions(dep)
    if (!Array.isArray(published)) {
      fail(release.pkg.name, [`npm view ${dep}: ${published.error}`])
      return false
    }
    if (!published.includes(pinned)) {
      fail(release.pkg.name, [
        `pins ${dep}@${pinned}, which is not on npm — installing it would fail.`,
        `Releases are ordered dependencies-first; check that ${dep} released in this run.`,
      ])
      return false
    }
    releasedNow.add(`${dep}@${pinned}`)
  }
  return true
}

async function publish(release: Release): Promise<boolean> {
  const { pkg, version } = release
  const published = await npmVersions(pkg.name)
  if (!Array.isArray(published)) {
    fail(pkg.name, [`npm view: ${published.error}`])
    return false
  }
  if (published.includes(version)) {
    console.log(`skip ${pkg.name}@${version} (already on npm)`)
    releasedNow.add(`${pkg.name}@${version}`)
    return true
  }
  const isNew = published.length === 0
  const blocker = initialPackageBlocker(published, { inCi, local, dryRun })
  if (blocker) {
    needsSeed.push(pkg.name)
    fail(pkg.name, blocker)
    return false
  }

  const packed = await $`bun pm pack --destination ${packDir} --quiet`
    .cwd(pkg.dir)
    .quiet()
    .nothrow()
  const tarball = packed.stdout.toString().trim().split("\n").pop()?.trim()
  if (packed.exitCode !== 0 || !tarball) {
    fail(pkg.name, ["bun pm pack failed", packed.stderr.toString()])
    return false
  }
  if (!(await assertInstallable(release, tarball))) return false
  if (dryRun) {
    console.log(`would publish ${pkg.name}@${version}${isNew ? " (new package)" : ""}`)
    releasedNow.add(`${pkg.name}@${version}`)
    return true
  }

  console.log(`publish ${pkg.name}@${version}${isNew ? " (new package)" : ""}`)
  const provenance = local ? "--provenance=false" : "--provenance"
  const args = ["publish", tarball, "--access", "public", provenance]
  const exitCode = await npm(args, pkg.dir)
  if (exitCode !== 0) {
    if (!isNew && !local) needsTrust.push(pkg.name)
    fail(pkg.name, [
      `npm publish exited ${exitCode}`,
      isNew
        ? "Run bun run release:seed with an interactive maintainer login."
        : `Check its Trusted Publisher (repo ${REPO}, workflow ${WORKFLOW_FILE}): https://www.npmjs.com/package/${pkg.name}/access`,
    ])
    return false
  }
  releasedNow.add(`${pkg.name}@${version}`)
  return true
}

// Read the initial settings in a batch while npm's two-factor skip is active.
// Consume each cached entry once so a post-mutation verification always reads npm again.
let initialTrust: Promise<Map<string, PackageTrust>> | undefined
const trust = trustedPublisherReconciler({
  refresh: refreshPublishers,
  async list(name) {
    if (typeof localTrustToken !== "string") {
      throw new Error(localTrustToken?.error ?? "npm trusted publisher lookup is unavailable")
    }
    const token = localTrustToken
    initialTrust ??= attended("the trusted publisher lookup", async () => {
      const loaded = await loadPackageTrust(
        trustPackages.map((pkg) => pkg.name),
        token,
      )
      if (!Array.isArray(loaded)) throw new Error(loaded.error)
      return new Map(loaded.map((pkg) => [pkg.name, pkg]))
    })
    const snapshot = await initialTrust
    let pkg = snapshot.get(name)
    snapshot.delete(name)
    if (!pkg) {
      const loaded = await attended("the trusted publisher verification", () =>
        loadPackageTrust([name], token),
      )
      if (!Array.isArray(loaded)) throw new Error(loaded.error)
      pkg = loaded[0]
    }
    if (!pkg || pkg.error) throw new Error(pkg?.error ?? "npm returned no trusted publisher")
    return JSON.stringify(pkg.configs ?? [])
  },
  async revoke(name, id) {
    return (await npm(["trust", "revoke", name, "--id", id])) === 0
  },
  async create(name) {
    const args = ["trust", "github", name, "--file", WORKFLOW_FILE, "--repository", REPO]
    if ((await npm([...args, "--allow-publish", "--yes"])) === 0) {
      console.log(`trust ${name}: GitHub Actions ${REPO}/${WORKFLOW_FILE}`)
      return true
    }
    console.warn(
      `::warning::Could not attach Trusted Publisher for ${name}; add it at https://www.npmjs.com/package/${name}/access`,
    )
    return false
  },
  onError(name, error) {
    console.warn(`::warning::Trusted Publisher for ${name} failed: ${redact(String(error))}`)
  },
})
const trustFailed = trust.failed

/** Attach the GitHub Actions Trusted Publisher so future releases need no token. */
async function ensureTrustedPublisher(name: string): Promise<void> {
  if (dryRun || !local) return
  await trust.ensure(name)
}

function detailOf(result: {
  stdout: { toString(): string }
  stderr: { toString(): string }
}): string {
  return redact(`${result.stderr.toString()}\n${result.stdout.toString()}`).trim()
}

/**
 * Create the GitHub Release for a tag that is already on origin.
 * Returns false only after the retries are exhausted. Never throws: one 500 must
 * not abort the rest of the seed.
 */
async function createGitHubRelease(tag: string, notes: string): Promise<boolean> {
  const hasRelease = await $`gh release view ${tag} --repo ${REPO}`.quiet().nothrow()
  if (hasRelease.exitCode === 0) return true
  const attempts = 6
  for (let attempt = 0; attempt < attempts; attempt++) {
    const created =
      await $`gh release create ${tag} --repo ${REPO} --title ${tag} --notes ${notes} --verify-tag --latest=false`
        .quiet()
        .nothrow()
    const detail = detailOf(created)
    if (created.exitCode === 0 || /already exists/i.test(detail)) return true
    const retry = attempt + 1 < attempts && isRetryableGitHubError(detail)
    if (!retry) {
      console.error(`::error::GitHub release for ${tag} failed\n  ${detail}`)
      return false
    }
    const delay = githubRetryDelayMs(attempt)
    console.warn(
      `::warning::GitHub release for ${tag} failed; retrying in ${delay / 1000}s\n  ${detail}`,
    )
    await Bun.sleep(delay)
  }
  return false
}

/** Notes for a tag that was pushed by an earlier run, whose planned notes are gone with that run. */
function releaseNoteForTag(tag: string): string {
  const at = tag.lastIndexOf("@")
  const name = tag.slice(0, at)
  const version = tag.slice(at + 1)
  return `npm: [${name}@${version}](https://www.npmjs.com/package/${name}/v/${version})`
}

/**
 * Tags from a run that died on `gh release create` are already the released version, so the
 * next plan skips them and would never create the release. Fill those in before publishing.
 * Returns how many are still missing.
 */
async function repairMissingReleases(): Promise<number> {
  const listed = await $`git tag --list ${"@crvouga/mockingbird-service-*"}`.cwd(root).quiet()
  const tags = listed
    .text()
    .split("\n")
    .map((tag) => tag.trim())
    .filter(Boolean)
  console.log("release:publish: checking for tags that never got a GitHub release")
  const remote = await $`gh api --paginate repos/${REPO}/releases --jq ${".[].tag_name"}`
    .quiet()
    .nothrow()
  if (remote.exitCode !== 0) {
    console.warn(`::warning::could not list GitHub releases\n  ${detailOf(remote)}`)
    return 0
  }
  const have = new Set(
    remote.stdout
      .toString()
      .split("\n")
      .map((tag) => tag.trim())
      .filter(Boolean),
  )
  const missing = tags.filter((tag) => !have.has(tag))
  if (missing.length === 0) return 0
  console.log(`release:publish: ${missing.length} existing tag(s) have no GitHub release`)
  let still = 0
  for (const tag of missing) {
    if (dryRun) {
      console.log(`would create release ${tag}`)
      continue
    }
    if (await createGitHubRelease(tag, releaseNoteForTag(tag))) console.log(`tagged ${tag}`)
    else still += 1
  }
  return still
}

async function tagAndRelease(release: Release): Promise<boolean> {
  const tag = tagName(release.pkg.name, release.version)
  const notes = releaseNotes(release, plan.versions)
  if (dryRun) {
    console.log(`would tag ${tag}\n${notes.replace(/^/gm, "    ")}`)
    return true
  }
  const exists = await $`git rev-parse -q --verify ${`refs/tags/${tag}`}`
    .cwd(root)
    .quiet()
    .nothrow()
  if (exists.exitCode !== 0) {
    const tagged = await $`git tag -a ${tag} -m ${tag}`.cwd(root).quiet().nothrow()
    if (tagged.exitCode !== 0) {
      console.error(`::error::git tag ${tag} failed\n  ${detailOf(tagged)}`)
      return false
    }
  }
  const pushed = await $`git push origin ${`refs/tags/${tag}`}`.cwd(root).quiet().nothrow()
  if (pushed.exitCode !== 0) {
    console.error(`::error::git push ${tag} failed\n  ${detailOf(pushed)}`)
    return false
  }
  if (!(await createGitHubRelease(tag, notes))) return false
  console.log(`tagged ${tag}`)
  return true
}

async function deprecateRetiredPackages(): Promise<void> {
  for (const retired of retiredPackages(plan.packages)) {
    const published = await npmVersions(retired.name)
    if (!Array.isArray(published) || published.length === 0) continue
    if (retired.requires) {
      const replacement = await npmVersions(retired.requires)
      if (!Array.isArray(replacement) || replacement.length === 0) continue
    }
    const current = await $`npm view ${retired.name} deprecated`.quiet().nothrow()
    if (current.exitCode !== 0 || current.stdout.toString().trim() !== "") continue
    if (dryRun || !local) {
      console.log(`${dryRun ? "would deprecate" : "run release:seed to deprecate"} ${retired.name}`)
      continue
    }
    if ((await npm(["deprecate", retired.name, retired.message])) === 0) {
      console.log(`deprecated ${retired.name}`)
    } else {
      console.warn(`::warning::npm deprecate ${retired.name} failed`)
    }
  }
}

let githubReleaseGaps = 0
try {
  if (!trustOnly && maintenance) githubReleaseGaps += await repairMissingReleases()
  // A package that cannot release never stops the independent ones; its dependents are skipped.
  // A GitHub release failure does not: the package is already on npm, and dependents may pin it.
  await releaseInOrder(
    plan.releases,
    async (release) => {
      try {
        if (!(await publish(release))) return false
        await ensureTrustedPublisher(release.pkg.name)
        if (!(await tagAndRelease(release))) githubReleaseGaps += 1
        return true
      } catch (error) {
        fail(release.pkg.name, [error instanceof Error ? error.message : String(error)])
        return false
      }
    },
    (release, blockedBy) =>
      fail(release.pkg.name, [`skipped: dependency failed to release (${blockedBy.join(", ")})`]),
  )
  // Reconcile: every published service is trusted for OIDC, everything else is deprecated.
  for (const pkg of local ? trustPackages : []) {
    if (!pkg.isPublic || failed.has(pkg.name)) continue
    const published = await npmVersions(pkg.name)
    if (trustOnly && !Array.isArray(published)) {
      fail(pkg.name, [`npm view: ${published.error}`])
      continue
    }
    if (trustOnly && dryRun && Array.isArray(published) && published.length > 0) {
      console.log(`would verify and repair Trusted Publisher for ${pkg.name}`)
    }
    if (Array.isArray(published) && published.length > 0) await ensureTrustedPublisher(pkg.name)
  }
  if (!trustOnly && maintenance) await deprecateRetiredPackages()
} finally {
  for (const path of changelogs) rmSync(path, { force: true })
  const skipped = restoreOriginals(originals)
  if (skipped > 0) {
    console.warn(
      `::warning::release checkout disappeared; skipped restoring ${skipped} temporary file(s)`,
    )
  }
  rmSync(packDir, { recursive: true, force: true })
}

const ok = trustOnly ? 0 : plan.releases.length - failed.size
console.log(
  `release:publish: released=${ok} failed=${failed.size} trusted-publisher-failed=${trustFailed.size} github-releases-missing=${githubReleaseGaps}${dryRun ? " (dry-run)" : ""}`,
)
for (const line of seedSummary({ needsSeed, needsTrust, failed: failed.size })) console.error(line)
if (githubReleaseGaps > 0) {
  console.error(
    `::error::${githubReleaseGaps} GitHub release(s) still missing. Re-run bun run release:seed; versions already on npm are skipped.`,
  )
}
if (trustFailed.size > 0) {
  console.error(
    `::error::${trustFailed.size} npm Trusted Publisher(s) still missing: ${[...trustFailed].join(", ")}`,
  )
  console.error(
    "Re-run bun run release:seed -- --trust-only to repair and verify publishers; healthy configurations are skipped.",
  )
}
if (failed.size > 0 || trustFailed.size > 0 || githubReleaseGaps > 0) process.exit(1)
