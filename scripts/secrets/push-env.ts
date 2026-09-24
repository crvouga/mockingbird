/**
 * Push values from .env.local → GitHub Actions repo secrets: the manifest's GitHub secrets plus
 * every `MOCKINGBIRD_*` value set there (live-parity credentials and settings).
 * Requires --yes. Never prints secret values.
 *
 *   bun run secrets:push -- --dry-run
 *   bun run secrets:push -- --yes
 */
import {
  ghAuthOk,
  hasFlag,
  isGitHubSecretEntry,
  loadManifest,
  PARITY_SECRET_PREFIX,
  parityRequirements,
  readEnvLocal,
  run,
  which,
} from "./lib.ts"

const argv = process.argv.slice(2)
const dryRun = hasFlag(argv, "--dry-run")
const yes = hasFlag(argv, "--yes")

if (!dryRun && !yes) {
  console.error("Refusing to write GitHub secrets without --yes (or use --dry-run).")
  console.error("Usage: bun run secrets:push -- --yes")
  console.error("       bun run secrets:push -- --dry-run")
  process.exit(2)
}

if (!(await which("gh"))) {
  console.error("FAIL: gh CLI not found. https://cli.github.com/")
  process.exit(1)
}

const manifest = await loadManifest()

const ghAuth = await ghAuthOk()
if (!ghAuth.ok) {
  console.error("FAIL: GitHub auth:", ghAuth.error)
  console.error("Fix: gh auth login")
  process.exit(1)
}

const envLocal = await readEnvLocal()
if (Object.keys(envLocal).length === 0) {
  console.error("FAIL: .env.local not found or empty.")
  console.error("Copy .env.example to .env.local and fill in values first.")
  process.exit(1)
}

// GitHub secret name → .env.local key. The first local_env name is a manifest entry's source.
const targets = new Map<string, string>()
for (const entry of manifest.secrets.filter(isGitHubSecretEntry)) {
  const sourceKey = entry.local_env[0]
  if (sourceKey) targets.set(entry.github.name, sourceKey)
}
for (const { env } of parityRequirements()) for (const name of env) targets.set(name, name)
// Optional parity settings (e.g. MOCKINGBIRD_JUNCTION_WEBHOOK_RECEIVER_URL) ride along: the
// Parity workflow exposes every MOCKINGBIRD_* secret.
for (const name of Object.keys(envLocal))
  if (name.startsWith(PARITY_SECRET_PREFIX)) targets.set(name, name)

let failed = false

for (const [ghName, sourceKey] of targets) {
  const value = envLocal[sourceKey]
  if (!value?.trim()) continue

  if (dryRun) {
    console.log(`[DRY] would set ${ghName} on ${manifest.repo} (value length=${value.length})`)
    continue
  }

  const result = await run(["gh", "secret", "set", ghName, "--repo", manifest.repo], {
    stdin: value,
  })

  if (!result.ok) {
    console.error(`[FAIL] gh secret set ${ghName}: ${result.stderr || result.stdout}`)
    failed = true
    continue
  }

  console.log(`[PASS] set GitHub secret ${ghName} on ${manifest.repo} from .env.local`)
}

if (failed) {
  console.error("")
  console.error("Push incomplete. See docs/SECRETS.md or bun run secrets:doctor")
  process.exit(1)
}

console.log("secrets:push OK")
process.exit(0)
