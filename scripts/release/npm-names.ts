/**
 * Fail when a public package does not exist on npm yet.
 *
 * Trusted Publishing (OIDC) cannot create a package, so merging a never-published one turns the
 * Release workflow on main red until a maintainer seeds it. This runs on every pull request so
 * the name is reserved first, from the branch: `bun run release:seed -- --reserve`.
 *
 *   bun run release:npm-names
 */
import { discoverPackages, reserveCommand, unreservedPackages } from "./lib.ts"

const names = discoverPackages()
  .filter((pkg) => pkg.isPublic)
  .map((pkg) => pkg.name)
const { missing, errors } = await unreservedPackages(names)

for (const { name, error } of errors) console.error(`::error::npm view ${name} failed: ${error}`)
if (missing.length > 0) {
  console.error(
    `::error::${missing.length} public package(s) are not on npm yet: ${missing.join(", ")}`,
  )
  console.error(
    "CI publishes with Trusted Publishing (OIDC), which cannot create a package, so the",
  )
  console.error("Release workflow would fail on main after this merges. A maintainer reserves the")
  console.error(`name from this branch with an interactive npm login, then re-runs this check:`)
  console.error(`  ${reserveCommand()}`)
}
if (missing.length > 0 || errors.length > 0) process.exit(1)
console.log(`release:npm-names: all ${names.length} public package(s) exist on npm`)
