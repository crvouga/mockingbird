/**
 * Loud preflight checks before monorepo publish on main.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
let failed = false

function error(title: string, details: string[]): void {
  failed = true
  console.error(`::error::${title}`)
  console.error("")
  console.error(`ERROR: ${title}`)
  console.error("=".repeat(72))
  for (const line of details) {
    console.error(line)
  }
  console.error("=".repeat(72))
  console.error("")
}

const npmToken = process.env.NPM_TOKEN?.trim() ?? ""
const inActions = process.env.GITHUB_ACTIONS === "true"
const oidcReady = Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL)

if (inActions && !npmToken && !oidcReady) {
  error("No npm publish credentials — cannot publish to npm", [
    "Publish needs Trusted Publishing (OIDC) for https://registry.npmjs.org",
    "",
    "Configure npm Trusted Publishing for each public @crvouga/mockingbird-* package:",
    "  1. Open the package on npm → Settings → Trusted Publisher",
    "  2. Add GitHub Actions publisher:",
    "       Organization/user: crvouga",
    "       Repository: mockingbird",
    "       Workflow filename: ci.yml",
    "       Environment: (leave empty unless you use one)",
    "  3. Re-run this workflow (id-token: write is already set on the release job)",
    "",
    "Seed the umbrella first if missing: bun run npm:seed -- --yes",
    "Docs: https://docs.npmjs.com/trusted-publishers",
    "Maintainer checklist: bun run secrets:doctor  →  docs/SECRETS.md",
  ])
}

if (inActions && !npmToken && oidcReady) {
  console.log(
    "release-preflight: NPM_TOKEN unset; using GitHub OIDC (npm Trusted Publishing must be configured).",
  )
}

const facadeDist = join(root, "packages/facade/dist/index.js")
if (!existsSync(facadeDist)) {
  error("Missing packages/facade/dist before release", [
    "The release job must build the workspace first.",
    "Run locally: bun run build",
  ])
}

if (failed) {
  console.error("release-preflight FAILED — refusing to publish.")
  process.exit(1)
}

console.log("release-preflight: OK")
if (oidcReady) {
  console.log("  - OIDC token endpoint available (Trusted Publishing)")
} else if (npmToken) {
  console.log("  - NPM_TOKEN is set (legacy); prefer Trusted Publishing — see docs/SECRETS.md")
} else {
  console.log(
    "  - no npm credentials in this shell (local dry-run / configure Trusted Publishing for CI)",
  )
}
