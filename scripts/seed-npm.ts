/**
 * One-time local publish of the umbrella package so Trusted Publisher can be attached.
 *
 *   bun run npm:seed -- --dry-run
 *   bun run npm:seed -- --yes
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { $ } from "bun"
import {
  hasFlag,
  NPM_PACKAGE,
  NPM_PACKAGE_URL,
  NPM_SEED_VERSION,
  NPM_TRUSTED_PUBLISHER_URL,
  npmViewVersion,
  root,
} from "./secrets/lib.ts"

const argv = process.argv.slice(2)
const dryRun = hasFlag(argv, "--dry-run")
const yes = hasFlag(argv, "--yes")

if (!dryRun && !yes) {
  console.error("Pass --yes to publish, or --dry-run to preview.")
  console.error(`Target: ${NPM_PACKAGE}@${NPM_SEED_VERSION}`)
  process.exit(1)
}

const viewed = await npmViewVersion(NPM_PACKAGE)
if (!viewed.missing && viewed.version) {
  console.log(`${NPM_PACKAGE}@${viewed.version} already exists — seed not needed.`)
  console.log(`Configure Trusted Publisher: ${NPM_TRUSTED_PUBLISHER_URL}`)
  process.exit(0)
}

const facade = join(root, "packages/facade")
if (!existsSync(join(facade, "dist/index.js"))) {
  console.error("Build the workspace first: bun run build")
  process.exit(1)
}

console.log(
  `${dryRun ? "Would publish" : "Publishing"} ${NPM_PACKAGE}@${NPM_SEED_VERSION} from packages/facade (no provenance; CI uses OIDC later)`,
)
console.log(`Package page: ${NPM_PACKAGE_URL}`)
if (dryRun) process.exit(0)

const result = await $`npm publish --access public`.cwd(facade).nothrow()
if (result.exitCode !== 0) {
  console.error(result.stderr.toString() || result.stdout.toString())
  process.exit(result.exitCode)
}
console.log(
  "Seeded. Next: attach Trusted Publisher for workflow ci.yml on repo crvouga/mockingbird",
)
console.log(NPM_TRUSTED_PUBLISHER_URL)
