/**
 * Publish every public workspace package whose version is not yet on npm.
 *
 * Uses npm Trusted Publishing (OIDC) in CI — no NPM_TOKEN.
 * Skips versions that already exist (idempotent re-runs).
 *
 *   bun run release:publish
 *   bun run release:publish -- --dry-run
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { $ } from "bun"
import { npmViewVersion, redactSecrets, root } from "./secrets/lib.ts"

const dryRun = process.argv.includes("--dry-run")

type Pkg = {
  dir: string
  name: string
  version: string
}

const collectPackages = (): Pkg[] => {
  const out: Pkg[] = []
  const roots = [join(root, "packages")]
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
          out.push({ dir: child, name: pkg.name, version: pkg.version })
        }
      } else {
        walk(child)
      }
    }
  }
  for (const r of roots) walk(r)
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

const packages = collectPackages()
if (packages.length === 0) {
  console.error("release:publish: no public packages found")
  process.exit(1)
}

console.log(`release:publish: ${packages.length} public packages${dryRun ? " (dry-run)" : ""}`)

let published = 0
let skipped = 0
let failed = 0

for (const pkg of packages) {
  const viewed = await npmViewVersion(pkg.name)
  if (viewed.error) {
    console.error(`FAIL ${pkg.name}: ${redactSecrets(viewed.error)}`)
    failed++
    continue
  }
  if (!viewed.missing && viewed.version === pkg.version) {
    console.log(`skip ${pkg.name}@${pkg.version} (already on npm)`)
    skipped++
    continue
  }
  const distJs = join(pkg.dir, "dist/index.js")
  if (!existsSync(distJs)) {
    console.error(`FAIL ${pkg.name}: missing dist/index.js — build first`)
    failed++
    continue
  }
  console.log(`${dryRun ? "would publish" : "publish"} ${pkg.name}@${pkg.version}`)
  if (dryRun) {
    published++
    continue
  }
  const result = await $`npm publish --access public --provenance`.cwd(pkg.dir).nothrow()
  if (result.exitCode !== 0) {
    console.error(`FAIL ${pkg.name}: npm publish exited ${result.exitCode}`)
    console.error(redactSecrets(result.stderr.toString() || result.stdout.toString()))
    failed++
    continue
  }
  published++
}

console.log(`release:publish: published=${published} skipped=${skipped} failed=${failed}`)
if (failed > 0) process.exit(1)
