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
 *   bun run release:seed -- --reserve      (claim new packages' npm names from a branch, then trust)
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
  debug,
  discoverPackages,
  githubRetryDelayMs,
  initialPackageBlocker,
  isRetryableGitHubError,
  log,
  mapPool,
  mutex,
  npmBurntVersions,
  npmVersions,
  type Plan,
  packedManifest,
  pinManifest,
  publishFailureKind,
  REPO,
  RESERVED_DIST_TAG,
  RESERVED_VERSION,
  type Release,
  redact,
  releaseInOrder,
  releaseNotes,
  reservationManifest,
  reservationReadme,
  retiredPackages,
  root,
  seedSummary,
  tagName,
  unresolvablePins,
  WORKFLOW_FILE,
  waitForNpmVersion,
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
const reserve = argv.includes("--reserve")
if (reserve && !trustOnly) throw new Error("--reserve requires --trust-only")
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

log("release:publish: planning")
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
  log("release:publish: reconciling Trusted Publishers only")
} else if (plan.releases.length === 0) {
  log("release:publish: nothing to release")
} else {
  log(
    `release:publish: ${plan.releases.length} package(s) still to release${dryRun ? " (dry-run)" : ""}: ${plan.releases.map((r) => `${r.pkg.name}@${r.version}`).join(", ")}`,
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
/**
 * Versions this process published, resolving to whether npm lists them yet. A dependent publishes
 * right after its dependency (npm does not resolve pins on publish) and is only tagged once
 * every pin it shares with this run is visible, so tags still mean "installable".
 */
const visibleNow = new Map<string, Promise<boolean>>()
/** Do not spend another propagation timeout on each package sharing a missing pin. */
const unavailablePins = new Map<string, string>()
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

/**
 * A local seed answers npm's 2FA prompts in one terminal, so interactive npm commands never
 * overlap even though publishing, waiting and trust run concurrently.
 */
const interactiveLock = mutex("interactive npm")
function interactive<T>(work: () => Promise<T>): Promise<T> {
  return local ? interactiveLock(work) : work()
}

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
  return interactive(async () => {
    const started = performance.now()
    debug(`npm ${args.join(" ")}`)
    const proc = Bun.spawn(["npm", ...args], {
      cwd,
      env: npmEnv,
      stdio: ["inherit", "inherit", "inherit"],
    })
    const code = await attended(`npm ${args[0]}`, () => proc.exited)
    debug(
      `npm ${args[0]} ${args[1] ?? ""} exited ${code} in ${((performance.now() - started) / 1000).toFixed(1)}s`,
    )
    return code
  })
}

/**
 * `npm publish`, keeping its output to tell a taken version or a missing Trusted Publisher from
 * other failures. A local seed inherits stdio instead, so it can answer 2FA prompts.
 */
async function npmPublish(
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; output: string }> {
  if (local) return { exitCode: await npm(args, cwd), output: "" }
  const proc = Bun.spawn(["npm", ...args], {
    cwd,
    env: npmEnv,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  process.stdout.write(out)
  process.stderr.write(err)
  return { exitCode, output: `${out}\n${err}` }
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
    const pin = `${dep}@${pinned}`
    // Published by this run moments ago: finish() checks it is visible before tagging.
    if (visibleNow.has(pin)) continue
    let pending = unavailablePins.get(pin)
    if (!pending) {
      if (dryRun) {
        const published = await npmVersions(dep)
        pending = !Array.isArray(published)
          ? `npm view ${dep}: ${published.error}`
          : published.includes(pinned)
            ? undefined
            : `pins ${pin}, which is not on npm — installing it would fail.`
      } else {
        // Another runner can still see stale registry metadata after the
        // prerequisite's publish check succeeded. Give this reader time too.
        pending = (await waitForNpmVersion(dep, pinned)) ?? undefined
      }
    }
    if (pending) {
      unavailablePins.set(pin, pending)
      fail(release.pkg.name, [pending])
      return false
    }
    releasedNow.add(pin)
  }
  return true
}

/**
 * Publish one release. "visible" when registry readers can already resolve the version (it was
 * on npm before, or this is a dry run), "pending" when npm accepted it but may still be
 * processing it, false when it failed.
 */
async function publish(release: Release): Promise<"visible" | "pending" | false> {
  const { pkg, version } = release
  const published = await npmVersions(pkg.name)
  if (!Array.isArray(published)) {
    fail(pkg.name, [`npm view: ${published.error}`])
    return false
  }
  if (published.includes(version)) {
    log(`skip ${pkg.name}@${version} (already on npm)`)
    releasedNow.add(`${pkg.name}@${version}`)
    return "visible"
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
    return "visible"
  }

  log(`publish ${pkg.name}@${version}${isNew ? " (new package)" : ""}`)
  const provenance = local ? "--provenance=false" : "--provenance"
  const args = ["publish", tarball, "--access", "public", provenance]
  const { exitCode, output } = await npmPublish(args, pkg.dir)
  if (exitCode === 0) return "pending"
  const kind = local ? "other" : publishFailureKind(output)
  if (kind === "version-taken") {
    // An earlier run that timed out after publishing leaves the version on npm without a tag;
    // that one only needs its tag. A version npm removed can never be reused: the next plan
    // skips it (computePlan), so it is reported without blaming the Trusted Publisher.
    const burnt = await npmBurntVersions(pkg.name)
    if (Array.isArray(burnt) && burnt.includes(version)) {
      fail(pkg.name, [
        `${pkg.name}@${version} was published and then removed on npm; npm never accepts it again.`,
        "The next release plan skips it and publishes the following patch version.",
      ])
      return false
    }
    console.log(`${pkg.name}@${version} was already published by an earlier run`)
    return "pending"
  }
  if (!isNew && !local && kind === "auth") needsTrust.push(pkg.name)
  fail(pkg.name, [
    `npm publish exited ${exitCode}`,
    isNew
      ? "Run bun run release:seed with an interactive maintainer login."
      : kind === "auth" || local
        ? `Check its Trusted Publisher (repo ${REPO}, workflow ${WORKFLOW_FILE}): https://www.npmjs.com/package/${pkg.name}/access`
        : "See the npm error above; retry the release once it is fixed.",
  ])
  return false
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
    initialTrust ??= interactive(() =>
      attended("the trusted publisher lookup", async () => {
        const loaded = await loadPackageTrust(
          trustPackages.map((pkg) => pkg.name),
          token,
        )
        if (!Array.isArray(loaded)) throw new Error(loaded.error)
        return new Map(loaded.map((pkg) => [pkg.name, pkg]))
      }),
    )
    const snapshot = await initialTrust
    let pkg = snapshot.get(name)
    snapshot.delete(name)
    if (!pkg) {
      const loaded = await interactive(() =>
        attended("the trusted publisher verification", () => loadPackageTrust([name], token)),
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
      log(`trust ${name}: GitHub Actions ${REPO}/${WORKFLOW_FILE}`)
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
/** Tags with a GitHub Release, from repairMissingReleases' listing; saves a `gh` call per tag. */
let knownReleases: Set<string> | undefined

async function createGitHubRelease(tag: string, notes: string): Promise<boolean> {
  if (knownReleases?.has(tag)) return true
  if (!knownReleases) {
    const hasRelease = await $`gh release view ${tag} --repo ${REPO}`.quiet().nothrow()
    if (hasRelease.exitCode === 0) return true
  }
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
  log("release:publish: checking for tags that never got a GitHub release")
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
  knownReleases = have
  debug(`${have.size} GitHub Releases listed`)
  const missing = tags.filter((tag) => !have.has(tag))
  if (missing.length === 0) return 0
  console.log(`release:publish: ${missing.length} existing tag(s) have no GitHub release`)
  let still = 0
  for (const tag of missing) {
    if (dryRun) {
      console.log(`would create release ${tag}`)
      continue
    }
    if (await createGitHubRelease(tag, releaseNoteForTag(tag))) log(`tagged ${tag}`)
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
  knownReleases?.add(tag)
  log(`tagged ${tag}`)
  return true
}

async function deprecateRetiredPackages(): Promise<void> {
  log("release:publish: checking retired packages")
  const candidates = retiredPackages(plan.packages)
  const pending = await mapPool(candidates, 8, async (candidate) => {
    const published = await npmVersions(candidate.name)
    if (!Array.isArray(published) || published.length === 0) return false
    if (candidate.requires) {
      const replacement = await npmVersions(candidate.requires)
      if (!Array.isArray(replacement) || replacement.length === 0) return false
    }
    const current = await $`npm view ${candidate.name} deprecated`.quiet().nothrow()
    return current.exitCode === 0 && current.stdout.toString().trim() === ""
  })
  for (const [index, retired] of candidates.entries()) {
    if (!pending[index]) continue
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

/**
 * Publish a placeholder for every public package npm has never seen, so OIDC can publish its
 * first release after merge. Runs from any branch: the placeholder carries no code from it.
 */
async function reserveNewPackages(): Promise<void> {
  for (const pkg of trustPackages) {
    const published = await npmVersions(pkg.name)
    if (!Array.isArray(published)) {
      fail(pkg.name, [`npm view: ${published.error}`])
      continue
    }
    if (published.length > 0) continue
    if (dryRun) {
      console.log(`would reserve ${pkg.name}@${RESERVED_VERSION} (dist-tag ${RESERVED_DIST_TAG})`)
      continue
    }
    const dir = mkdtempSync(join(packDir, "reserve-"))
    writeFileSync(join(dir, "package.json"), reservationManifest(pkg.name))
    writeFileSync(join(dir, "README.md"), reservationReadme(pkg.name))
    console.log(`reserve ${pkg.name}@${RESERVED_VERSION}`)
    const args = [
      "publish",
      dir,
      "--access",
      "public",
      "--provenance=false",
      "--tag",
      RESERVED_DIST_TAG,
    ]
    if ((await npm(args, dir)) !== 0) {
      fail(pkg.name, ["npm publish of the name placeholder failed"])
      continue
    }
    const pending = await waitForNpmVersion(pkg.name, RESERVED_VERSION)
    if (pending) fail(pkg.name, [pending])
  }
}

let githubReleaseGaps = 0
/** Tags and GitHub Releases are created one at a time, in the order packages were published. */
let tagging: Promise<unknown> = Promise.resolve()
function serially(work: () => Promise<void>): Promise<void> {
  const run = tagging.then(work)
  tagging = run.catch(() => {})
  return run
}

/**
 * Wait until npm serves the version. This runs in the background while the next package
 * publishes, locally and in CI: npm takes seconds to minutes per version to list a publish, and
 * waiting for each in turn made a seed crawl and ran a 16-package CI shard past its job timeout,
 * killing it between publish and tag. finish() tags a release only once it and every dependency
 * released by this run are visible.
 */
async function waitVisible(release: Release): Promise<boolean> {
  const { pkg, version } = release
  const pending = await waitForNpmVersion(pkg.name, version)
  if (pending) {
    fail(pkg.name, [pending])
    return false
  }
  releasedNow.add(`${pkg.name}@${version}`)
  return true
}

/** Each release's finish(), by name: resolves true once it is visible on npm (and tagged, if it could be). */
const finished = new Map<string, Promise<boolean>>()

async function finish(release: Release, visibility: "visible" | "pending"): Promise<boolean> {
  const { pkg, version } = release
  try {
    if (visibility === "pending" && !(await visibleNow.get(`${pkg.name}@${version}`))) return false
    // Dependencies released by this run are visible (and tagged) first, so a tag always means
    // "installable" and tags keep their dependency order.
    const deps = pkg.runtimeDeps.filter((dep) => finished.has(dep))
    const ready = await Promise.all(deps.map((dep) => finished.get(dep)))
    const missing = deps.filter((_, index) => !ready[index])
    if (missing.length > 0) {
      fail(pkg.name, [
        `not tagged: a dependency never became visible on npm (${missing.join(", ")})`,
      ])
      return false
    }
    await serially(async () => {
      await ensureTrustedPublisher(pkg.name)
      if (!(await tagAndRelease(release))) githubReleaseGaps += 1
    })
    return true
  } catch (error) {
    fail(pkg.name, [error instanceof Error ? error.message : String(error)])
    return false
  }
}

const finishing: Promise<boolean>[] = []
try {
  if (reserve) await reserveNewPackages()
  if (!trustOnly && maintenance) githubReleaseGaps += await repairMissingReleases()
  // A package that cannot release never stops the independent ones; its dependents are skipped.
  // A GitHub release failure does not: the package is already on npm, and dependents may pin it.
  await releaseInOrder(
    plan.releases,
    async (release) => {
      try {
        const visibility = await publish(release)
        if (!visibility) return false
        if (visibility === "pending") {
          visibleNow.set(`${release.pkg.name}@${release.version}`, waitVisible(release))
        }
        // Waiting for npm to list the version, trust and tagging run in the background while
        // the next package publishes; interactive npm prompts still take turns (interactive()).
        const done = finish(release, visibility)
        finished.set(release.pkg.name, done)
        finishing.push(done)
        return true
      } catch (error) {
        fail(release.pkg.name, [error instanceof Error ? error.message : String(error)])
        return false
      }
    },
    (release, blockedBy) =>
      fail(release.pkg.name, [`skipped: dependency failed to release (${blockedBy.join(", ")})`]),
  )
  if (finishing.length > 0)
    log(`release:publish: waiting on ${finishing.length} release(s) to finish`)
  await Promise.all(finishing)
  // Reconcile: every published service is trusted for OIDC, everything else is deprecated.
  const reconcile = (local ? trustPackages : []).filter(
    (pkg) => pkg.isPublic && !failed.has(pkg.name),
  )
  if (reconcile.length > 0)
    log(`release:publish: checking Trusted Publishers for ${reconcile.length} package(s)`)
  const reconcileVersions = await mapPool(reconcile, 16, (pkg) => npmVersions(pkg.name))
  for (const [index, pkg] of reconcile.entries()) {
    const published = reconcileVersions[index] as Awaited<ReturnType<typeof npmVersions>>
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
log(
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
