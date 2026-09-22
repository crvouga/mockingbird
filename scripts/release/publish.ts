/**
 * Release every public package that changed since its last `<name>@<version>` tag.
 *
 * For each release (dependencies first):
 *   1. pack with `bun pm pack` (rewrites `workspace:*` to the exact released versions)
 *   2. npm publish — Trusted Publishing (OIDC) for packages that exist on npm;
 *      NPM_TOKEN for brand-new packages, which then get their Trusted Publisher
 *      attached automatically (`npm trust github`)
 *   3. push the `<name>@<version>` tag and create its GitHub Release
 * Then reconcile npm with the workspace: attach the Trusted Publisher to every published
 * service that lacks one, and deprecate every package this repo no longer
 * publishes — the archived legacy packages (@crvouga/postgres-mem, @crvouga/sqlite-mem)
 * and every private workspace package still on npm (only mock services are published).
 *
 * Every step is idempotent: versions already on npm, existing tags and existing
 * GitHub Releases are skipped, so a failed run is fixed by re-running it.
 *
 *   bun run release:publish -- --dry-run   (plan + pack, no side effects)
 *   bun run release:publish                (CI, on main)
 *   bun run release:publish -- --local     (maintainer bootstrap: your npm login, no provenance)
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { $ } from "bun"
import { VERSION_PLACEHOLDER } from "../bundle-service-version.ts"
import {
  changelog,
  computePlan,
  npmVersions,
  packedManifest,
  pinManifest,
  REPO,
  type Release,
  redact,
  releaseNotes,
  retiredPackages,
  root,
  tagName,
  unresolvablePins,
  WORKFLOW_FILE,
} from "./lib.ts"

const argv = process.argv.slice(2)
const dryRun = argv.includes("--dry-run")
const local = argv.includes("--local")
const inCi = process.env.GITHUB_ACTIONS === "true"
const npmToken = process.env.NPM_TOKEN?.trim() || ""
/** Credentials that can create packages and change package settings (OIDC can only publish). */
const hasAccountAuth = local || npmToken !== ""

if (!dryRun && !inCi && !local) {
  console.error("release:publish: runs in CI. Use --dry-run to preview, or --local to bootstrap.")
  process.exit(1)
}

if (local && !dryRun) {
  await $`git fetch origin main --tags`.cwd(root).quiet()
  const head = (await $`git rev-parse HEAD`.cwd(root).quiet()).text().trim()
  const main = (await $`git rev-parse origin/main`.cwd(root).quiet()).text().trim()
  if (head !== main) {
    console.error("release:publish --local must run from a checkout of origin/main")
    process.exit(1)
  }
}

const plan = await computePlan()
if (plan.releases.length === 0) {
  console.log("release:publish: nothing to release")
} else {
  console.log(`release:publish: ${plan.releases.length} package(s)${dryRun ? " (dry-run)" : ""}`)
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
  writeFileSync(path, await changelog(release.pkg, release))
  changelogs.push(path)
}

const packDir = mkdtempSync(join(tmpdir(), "mockingbird-release-"))
const failed = new Set<string>()
/** `<name>@<version>` of everything this run put on npm, which `npm view` may not show yet. */
const releasedNow = new Set<string>()
// setup-node's .npmrc reads NODE_AUTH_TOKEN; leave it empty to force OIDC. Locally, use the npm login.
const npmEnv = (withToken: boolean) =>
  local ? process.env : { ...process.env, NODE_AUTH_TOKEN: withToken ? npmToken : "" }

/** Runs npm with inherited stdio so a local run can answer 2FA prompts. */
async function npm(args: string[], withToken: boolean, cwd = root): Promise<number> {
  const proc = Bun.spawn(["npm", ...args], {
    cwd,
    env: npmEnv(withToken),
    stdio: ["inherit", "inherit", "inherit"],
  })
  return await proc.exited
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
  if (isNew && inCi && !local && !npmToken && !dryRun) {
    fail(pkg.name, [
      "package does not exist on npm yet, and Trusted Publishing (OIDC) cannot create packages.",
      "Fix once, either way:",
      "  - add an npm granular access token (read+write, @crvouga scope) as the NPM_TOKEN",
      `    Actions secret on ${REPO}, then re-run this workflow; or`,
      "  - locally, from any checkout: bun run release:seed",
    ])
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
  let exitCode = await npm(args, isNew, pkg.dir)
  if (exitCode !== 0 && !isNew && npmToken) {
    console.warn(`::warning::OIDC publish of ${pkg.name} failed; retrying with NPM_TOKEN`)
    exitCode = await npm(args, true, pkg.dir)
  }
  if (exitCode !== 0) {
    fail(pkg.name, [
      `npm publish exited ${exitCode}`,
      isNew
        ? "NPM_TOKEN must be able to create packages in the @crvouga scope."
        : `Check its Trusted Publisher (repo ${REPO}, workflow ${WORKFLOW_FILE}): https://www.npmjs.com/package/${pkg.name}/access`,
    ])
    return false
  }
  releasedNow.add(`${pkg.name}@${version}`)
  return true
}

/** Attach the GitHub Actions Trusted Publisher so future releases need no token. */
async function ensureTrustedPublisher(name: string): Promise<void> {
  if (dryRun || !hasAccountAuth) return
  const listed = await $`npm trust list ${name} --json`.env(npmEnv(true)).quiet().nothrow()
  if (listed.exitCode === 0 && listed.stdout.toString().includes(REPO)) return
  const trust = ["trust", "github", name, "--file", WORKFLOW_FILE, "--repository", REPO]
  if ((await npm([...trust, "--allow-publish", "--yes"], true)) === 0) {
    console.log(`trust ${name}: GitHub Actions ${REPO}/${WORKFLOW_FILE}`)
  } else {
    console.warn(
      `::warning::Could not attach Trusted Publisher for ${name}; add it at https://www.npmjs.com/package/${name}/access`,
    )
  }
}

async function tagAndRelease(release: Release): Promise<void> {
  const tag = tagName(release.pkg.name, release.version)
  const notes = releaseNotes(release, plan.versions)
  if (dryRun) {
    console.log(`would tag ${tag}\n${notes.replace(/^/gm, "    ")}`)
    return
  }
  const exists = await $`git rev-parse -q --verify ${`refs/tags/${tag}`}`
    .cwd(root)
    .quiet()
    .nothrow()
  if (exists.exitCode !== 0) {
    await $`git tag -a ${tag} -m ${tag}`.cwd(root).quiet()
  }
  await $`git push origin ${`refs/tags/${tag}`}`.cwd(root).quiet()
  const hasRelease = await $`gh release view ${tag} --repo ${REPO}`.quiet().nothrow()
  if (hasRelease.exitCode !== 0) {
    await $`gh release create ${tag} --repo ${REPO} --title ${tag} --notes ${notes} --verify-tag --latest=false`.quiet()
  }
  console.log(`tagged ${tag}`)
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
    if (dryRun || !hasAccountAuth) {
      console.log(`${dryRun ? "would deprecate" : "needs NPM_TOKEN to deprecate"} ${retired.name}`)
      continue
    }
    if ((await npm(["deprecate", retired.name, retired.message], true)) === 0) {
      console.log(`deprecated ${retired.name}`)
    } else {
      console.warn(`::warning::npm deprecate ${retired.name} failed`)
    }
  }
}

try {
  for (const release of plan.releases) {
    const blockedBy = release.pkg.runtimeDeps.filter((d) => failed.has(d))
    if (blockedBy.length > 0) {
      fail(release.pkg.name, [`skipped: dependency failed to release (${blockedBy.join(", ")})`])
      continue
    }
    if (!(await publish(release))) continue
    await ensureTrustedPublisher(release.pkg.name)
    await tagAndRelease(release)
  }
  // Reconcile: every published service is trusted for OIDC, everything else is deprecated.
  for (const pkg of plan.packages) {
    if (!pkg.isPublic || failed.has(pkg.name)) continue
    const published = await npmVersions(pkg.name)
    if (Array.isArray(published) && published.length > 0) await ensureTrustedPublisher(pkg.name)
  }
  await deprecateRetiredPackages()
} finally {
  for (const path of changelogs) rmSync(path, { force: true })
  for (const [path, raw] of originals) writeFileSync(path, raw)
  rmSync(packDir, { recursive: true, force: true })
}

const ok = plan.releases.length - failed.size
console.log(`release:publish: released=${ok} failed=${failed.size}${dryRun ? " (dry-run)" : ""}`)
if (failed.size > 0) process.exit(1)
