/**
 * One-command onboarding: install, build, and prep local env — then say exactly
 * what to run next. Needs nothing but bun (and, for live parity, `gh auth login` with
 * write access to the repo). Safe to re-run any time (never overwrites .env.local).
 *
 *   bun run setup
 */
import { existsSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")

function step(label: string): void {
  console.log("")
  console.log(`▸ ${label}`)
}

async function run(cmd: string[]): Promise<void> {
  console.log(`  $ ${cmd.join(" ")}`)
  const proc = Bun.spawn(cmd, { cwd: root, stdio: ["inherit", "inherit", "inherit"] })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    console.error(`\n"${cmd.join(" ")}" failed (exit ${exitCode}).`)
    process.exit(exitCode)
  }
}

console.log("mockingbird setup")
console.log("==================")

step("Installing dependencies")
await run(["bun", "install", "--frozen-lockfile"])

// On a genuinely fresh install, bun only links a workspace package's `bin` if its
// dist/ file already exists at install time — it doesn't retroactively pick one up.
// @crvouga/mockingbird-openapi-codegen's bin (mockingbird-codegen) doesn't exist until
// it's built, so a first-ever `bun install && bun run build` leaves every service
// package's `generate` step failing with "mockingbird-codegen: command not found".
// Fix: build just that package, reinstall to link its now-existing bin, then build
// everything else. This is idempotent and a no-op once dist/ already exists.
step("Building the codegen package first (needed to link its CLI bin)")
await run(["bunx", "turbo", "run", "build", "--filter=@crvouga/mockingbird-openapi-codegen"])

step("Reinstalling to link the codegen CLI bin")
await run(["bun", "install", "--frozen-lockfile"])

step("Building every package (needed once for typecheck/test/generate)")
await run(["bun", "run", "build"])

step("Local env file (.env.local)")
const envLocalPath = join(root, ".env.local")
const envExamplePath = join(root, ".env.example")
if (existsSync(envLocalPath)) {
  console.log("  .env.local already exists — leaving it as-is.")
} else if (existsSync(envExamplePath)) {
  await Bun.write(envLocalPath, await Bun.file(envExamplePath).text())
  console.log("  Created .env.local from .env.example (all blank).")
} else {
  console.log("  No .env.example found — skipping.")
}

step("GitHub CLI (only for live parity)")
const ghReady = (() => {
  try {
    return Bun.spawnSync(["gh", "auth", "status"], { stdout: "ignore", stderr: "ignore" }).success
  } catch {
    return false // gh not installed
  }
})()
console.log(
  ghReady
    ? "  gh is authenticated — bun run parity:remote will work if you have write access."
    : "  gh is missing or not logged in — only needed for live parity: gh auth login",
)

console.log("")
console.log("Done. No secrets are needed for any of this:")
console.log("")
console.log("  bun test            # property-based suite — every mock's self-parity")
console.log("  bun run check       # everything CI checks: lint, typecheck, tests, boundaries...")
console.log("  bun docs            # docs site with live playgrounds")
console.log("")
console.log("Live parity against the real provider sandboxes runs on GitHub Actions with the")
console.log("repo's secrets, so you never need the keys yourself (push your branch first):")
console.log("")
console.log("  bun run parity:remote -- stripe      # or several services, or --all")
console.log("  bun run secrets:doctor               # which services have keys configured")
console.log("")
console.log("To run parity locally instead, put your own sandbox keys in .env.local")
console.log("(names in .env.example), then: bun run parity:service -- stripe")
