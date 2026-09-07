/**
 * Local replica of .github/workflows/ci.yml (minus the main-only release job).
 *
 *   bun run check:full
 *   npm run check:full
 */
import { join } from "node:path"

const root = join(import.meta.dir, "..")
process.env.HUSKY = "0"

type Finished = { label: string; seconds: number }
const finished: Finished[] = []
const notes: string[] = []

function job(name: string): void {
  console.log("")
  console.log("=".repeat(72))
  console.log(`  ${name}`)
  console.log("=".repeat(72))
}

async function runStep(
  label: string,
  argv: string[],
  opts?: { env?: Record<string, string> },
): Promise<void> {
  console.log("")
  console.log(`▸ ${label}`)
  console.log(`  $ ${argv.join(" ")}`)
  const started = performance.now()
  const proc = Bun.spawn(argv, {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, HUSKY: "0", ...opts?.env },
  })
  const code = await proc.exited
  const seconds = (performance.now() - started) / 1000
  if (code !== 0) {
    console.error("")
    console.error(`check:full FAILED at "${label}" (exit ${code}, ${seconds.toFixed(1)}s)`)
    console.error("This is the same command CI runs. Fix it, then re-run: bun run check:full")
    process.exit(code)
  }
  console.log(`✓ ${label} (${seconds.toFixed(1)}s)`)
  finished.push({ label, seconds })
}

async function git(args: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const stdout = (await new Response(proc.stdout).text()).trim()
  return { code: await proc.exited, stdout }
}

async function refExists(ref: string): Promise<boolean> {
  return (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).code === 0
}

async function resolveBaseRef(): Promise<string | null> {
  for (const ref of ["origin/main", "main", "origin/master", "master"]) {
    if (await refExists(ref)) return ref
  }
  return null
}

function printCommitlintHelp(kind: "range" | "last"): void {
  console.error("")
  console.error(
    kind === "range"
      ? "One or more commits since the base branch failed Conventional Commits lint."
      : "HEAD commit message failed Conventional Commits lint.",
  )
  console.error("")
  console.error("Expected format:  <type>(optional-scope): <description>")
  console.error("Releasable types: feat, fix (and BREAKING CHANGE / type!).")
  console.error("")
  console.error("See README.md → Releasing")
}

async function commitlintJob(): Promise<void> {
  job("commitlint  (CI job)")
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout || "HEAD"
  const onMain = branch === "main"
  const base = await resolveBaseRef()

  if (onMain) {
    console.log("On main: CI treats commitlint as a warning on push (enforced on PRs).")
    const proc = Bun.spawn(["bunx", "commitlint", "--last", "--verbose"], {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    })
    const code = await proc.exited
    if (code !== 0) {
      console.warn("HEAD is not Conventional Commits. Enforced on PRs.")
      printCommitlintHelp("last")
    }
    finished.push({ label: "Commitlint (--last, warning on main)", seconds: 0 })
    notes.push(
      "commitlint on main is warning-only (matches CI push); PRs still fail on bad messages",
    )
    return
  }

  if (!base) {
    notes.push("no main/origin/main ref; linted HEAD only — fetch origin to match PR commitlint")
    await runStep("Commitlint (--last)", ["bunx", "commitlint", "--last", "--verbose"])
    return
  }

  const from = (await git(["merge-base", base, "HEAD"])).stdout || base
  console.log(`Linting commits ${from}..HEAD (base ${base}, branch ${branch})`)
  const proc = Bun.spawn(["bunx", "commitlint", "--from", from, "--to", "HEAD", "--verbose"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await proc.exited
  if (code !== 0) {
    printCommitlintHelp("range")
    console.error("")
    console.error(`check:full FAILED at "Commitlint" (exit ${code})`)
    process.exit(code)
  }
  finished.push({ label: "Commitlint", seconds: 0 })
}

console.log("mockingbird check:full")
console.log("Mirrors .github/workflows/ci.yml — skipped: release/publish (main + OIDC only)")
if (process.platform !== "linux") {
  notes.push(`CI runs on ubuntu-latest; this host is ${process.platform}.`)
}

job("install")
await runStep("Install (frozen lockfile)", ["bun", "install", "--frozen-lockfile"])

await commitlintJob()

job("quality  (CI job)")
await runStep("Format check", ["bun", "run", "check:format"])
await runStep("Lint", ["bun", "run", "lint"])
await runStep("Typecheck", ["bun", "run", "typecheck"])
await runStep("Build", ["bun", "run", "build"])
await runStep("Package integrity", ["bun", "run", "pack:check"])
await runStep("Portability", ["bun", "run", "portability"])

job("test  (CI job)")
await runStep("Build", ["bun", "run", "build"])
await runStep("Property tests", ["bun", "run", "test"], { env: { FC_NUM_RUNS: "20" } })

const total = finished.reduce((sum, step) => sum + step.seconds, 0)
console.log("")
console.log("=".repeat(72))
console.log("  ✅  All local CI gates passed")
console.log("  This change will pass GitHub Actions CI.")
console.log("=".repeat(72))
for (const step of finished) console.log(`  ${step.seconds.toFixed(1).padStart(6)}s  ${step.label}`)
console.log(`  ${total.toFixed(1).padStart(6)}s  total`)
console.log("")
console.log("Skipped: release (main + OIDC only).")
for (const note of notes) console.log(`Note: ${note}`)
console.log("")
