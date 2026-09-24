/**
 * Secrets doctor: GitHub Actions repo secrets + .env.local + the Trusted Publishing checklist,
 * and which services can run live parity where (on GitHub, locally, or neither).
 * Values are never printed — GitHub cannot return them, and local ones stay in memory.
 *
 *   bun run secrets:doctor
 */

import { discoverPackages, npmVersions } from "../release/lib.ts"
import {
  type CheckResult,
  ghAuthOk,
  ghSecretNames,
  loadManifest,
  localEnvStatus,
  parityRequirements,
  printCheck,
  printObtain,
  printPopulate,
  readEnvLocal,
  which,
} from "./lib.ts"

console.log("mockingbird secrets doctor")
console.log("==========================")
console.log("Source of truth: GitHub Actions repo secrets. Values are never printed.")
console.log("Nothing here is needed to build, test, or run `bun run check`.")
console.log("See docs/SECRETS.md for the full runbook.")
console.log("")

const results: CheckResult[] = []
const manifest = await loadManifest()
console.log(`Repo: ${manifest.repo}`)
console.log("")

for (const pkg of discoverPackages().filter((p) => p.isPublic)) {
  const versions = await npmVersions(pkg.name)
  if (!Array.isArray(versions)) {
    results.push({
      id: `npm:${pkg.name}`,
      status: "warn",
      message: `Could not query npm for ${pkg.name}`,
      details: [versions.error],
    })
  } else if (versions.length === 0) {
    results.push({
      id: `npm:${pkg.name}`,
      status: "warn",
      message: `${pkg.name} is not on npm yet — the next release creates it`,
      details: ["Needs the NPM_TOKEN repo secret (bun run release:bootstrap)"],
    })
  }
}

// --- GitHub ---
let ghNames: Set<string> | null = null
if (!(await which("gh"))) {
  results.push({
    id: "tool:gh",
    status: "fail",
    message: "gh CLI missing",
    details: ["https://cli.github.com/", "Then: gh auth login"],
  })
} else {
  const auth = await ghAuthOk()
  if (!auth.ok) {
    results.push({
      id: "gh-auth",
      status: "fail",
      message: "gh not authenticated",
      details: [auth.error ?? "auth failed", "gh auth login"],
    })
  } else {
    results.push({ id: "gh-auth", status: "pass", message: "gh authenticated" })
    const listed = await ghSecretNames(manifest.repo)
    if (!listed.names) {
      results.push({
        id: "gh-secrets",
        status: "warn",
        message: `Cannot list repo secrets (needs write access to ${manifest.repo})`,
        details: [listed.error ?? "list failed"],
      })
    } else {
      ghNames = new Set(listed.names)
      results.push({
        id: "gh-secrets",
        status: "pass",
        message: `${ghNames.size} secret name(s) listed`,
      })
    }
  }
}

for (const entry of manifest.secrets) {
  const ghName = entry.github.name
  if (!ghName || !ghNames) continue
  if (ghNames.has(ghName)) {
    results.push({ id: `github:${entry.id}`, status: "pass", message: `${ghName} is set` })
  } else {
    results.push({
      id: `github:${entry.id}`,
      status: entry.github.required ? "fail" : "warn",
      message: `${entry.github.required ? "Required" : "Optional"} repo secret missing: ${ghName}`,
      details: [`https://github.com/${manifest.repo}/settings/secrets/actions`],
    })
  }
}

console.log("--- Checks ---")
for (const r of results) printCheck(r)

// --- Live parity readiness ---
const envLocal = await readEnvLocal()
const isLocal = (name: string) => Boolean(envLocal[name]?.trim() || process.env[name]?.trim())
console.log("")
console.log("--- Live parity credentials (per service) ---")
console.log(
  "  github = bun run parity:remote -- <service>   local = bun run parity:service -- <service>",
)
for (const { service, env } of parityRequirements()) {
  const onGitHub = ghNames ? env.filter((name) => !ghNames?.has(name)) : null
  const locally = env.filter((name) => !isLocal(name))
  const github = onGitHub === null ? "?" : onGitHub.length === 0 ? "ready" : "missing"
  const local = locally.length === 0 ? "ready" : "missing"
  console.log(`  ${service.padEnd(16)} github: ${github.padEnd(8)} local: ${local}`)
  if (onGitHub && onGitHub.length > 0 && onGitHub.length < env.length)
    console.log(`    missing on GitHub: ${onGitHub.join(", ")}`)
}

console.log("")
console.log("--- Other local values (.env.local) ---")
for (const entry of manifest.secrets) {
  const { set } = localEnvStatus(entry.local_env)
  const inEnvLocal = entry.local_env.filter((name) => envLocal[name]?.trim())
  const all = [...new Set([...set, ...inEnvLocal])]
  printCheck({
    id: `local:${entry.id}`,
    status: all.length > 0 ? "pass" : "skip",
    message: all.length > 0 ? `set: ${all.join(", ")}` : `unset (${entry.description})`,
  })
}

console.log("")
console.log("--- External checklists (manual) ---")
for (const item of manifest.checklists) {
  printCheck({
    id: `checklist:${item.id}`,
    status: item.required ? "warn" : "skip",
    message: item.required
      ? `${item.description} — confirm in npm UI (not auto-verified)`
      : item.description,
  })
  printObtain(item)
}

const failed = results.filter((r) => r.status === "fail")
for (const entry of manifest.secrets) {
  if (!failed.some((r) => r.id === `github:${entry.id}`)) continue
  console.log("")
  console.log(`# ${entry.id} — ${entry.description}`)
  printObtain(entry)
  printPopulate(entry)
}

console.log("")
console.log(failed.length > 0 ? "secrets:doctor FAILED" : "secrets:doctor OK")
process.exit(failed.length > 0 ? 1 : 0)
