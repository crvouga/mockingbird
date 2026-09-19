/**
 * One-time local publish of the umbrella package so Trusted Publisher can be attached.
 *
 * The npm token is read from self-hosted Vault/OpenBao and is only written to a
 * temporary npm config file for the duration of `npm publish`.
 *
 *   bun run npm:seed -- --dry-run
 *   bun run npm:seed -- --yes
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { $ } from "bun"
import {
  hasFlag,
  loadVaultConfig,
  NPM_PACKAGE,
  NPM_PACKAGE_URL,
  NPM_SEED_VERSION,
  NPM_TRUSTED_PUBLISHER_URL,
  npmViewVersion,
  redactSecrets,
  root,
  vaultFieldValue,
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
if (viewed.error) {
  console.error(`Cannot query npm: ${redactSecrets(viewed.error)}`)
  process.exit(1)
}
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
  `${dryRun ? "Would publish" : "Publishing"} ${NPM_PACKAGE}@${NPM_SEED_VERSION} from packages/facade (without provenance; local bootstrap only)`,
)
console.log(`Package page: ${NPM_PACKAGE_URL}`)
if (dryRun) process.exit(0)

const cfg = await loadVaultConfig()
const vaultPath = process.env.MOCKINGBIRD_NPM_VAULT_PATH?.trim() || "secret"
const vaultField = process.env.MOCKINGBIRD_NPM_VAULT_FIELD?.trim() || "NPM_TOKEN"
const token = await vaultFieldValue(cfg, vaultPath, vaultField)
if (!token.value) {
  console.error(
    `Could not load npm credentials from Vault: ${token.error ?? `missing ${vaultField}`}`,
  )
  console.error(`Expected: vault kv get -mount=${cfg.mount} -field=${vaultField} ${vaultPath}`)
  console.error("Log in first: bun run vault:login -- <username>")
  process.exit(1)
}

const npmrcDir = join(tmpdir(), `mockingbird-npm-${process.pid}`)
const npmrcPath = join(npmrcDir, ".npmrc")
mkdirSync(npmrcDir, { recursive: true })
writeFileSync(
  npmrcPath,
  `//registry.npmjs.org/:_authToken=${token.value.trim()}\nregistry=https://registry.npmjs.org/\nalways-auth=true\n`,
  { mode: 0o600 },
)

try {
  const result = await $`npm publish --access public --provenance=false`
    .cwd(facade)
    .env({ NPM_CONFIG_USERCONFIG: npmrcPath })
    .nothrow()
  if (result.exitCode !== 0) {
    console.error(redactSecrets(result.stderr.toString() || result.stdout.toString()))
    process.exit(result.exitCode)
  }
} finally {
  rmSync(npmrcDir, { recursive: true, force: true })
}

console.log(
  "Seeded. Next: attach Trusted Publisher for workflow ci.yml on repo crvouga/mockingbird",
)
console.log(NPM_TRUSTED_PUBLISHER_URL)
