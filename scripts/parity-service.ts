/**
 * Live parity for one, several, or every published HTTP service, with sandbox credentials from
 * Vault `secret/personal/prd` (`vault run --config prd`).
 *
 * Each service's `parity` script exits 0 on parity, 1 on a divergence, and 2 when its sandbox
 * credentials are missing. This runner reports all three separately, so "no credentials" is never
 * mistaken for "passed".
 *
 *   bun run parity:service -- twilio stripe      # the named services
 *   bun run parity:service -- --all              # every service with a parity script
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const servicesDir = join(root, "packages/service")

const withParity = readdirSync(servicesDir).filter((name) => {
  try {
    const pkg = JSON.parse(readFileSync(join(servicesDir, name, "package.json"), "utf8")) as {
      scripts?: Record<string, string>
    }
    return typeof pkg.scripts?.parity === "string"
  } catch {
    return false
  }
})

const args = process.argv.slice(2).filter((a) => a !== "--")
const wanted = args.includes("--all") ? withParity : args
if (wanted.length === 0) {
  console.error(
    `usage: bun run parity:service -- <service…> | --all\nservices: ${withParity.join(", ")}`,
  )
  process.exit(2)
}
const unknown = wanted.filter((name) => !withParity.includes(name))
if (unknown.length > 0) {
  console.error(`no parity script for: ${unknown.join(", ")}`)
  process.exit(2)
}

/**
 * Keys a service's parity script reads, when Vault stores them under the vendor's own name.
 * Mapped inside the child's environment; values are never printed.
 */
const ALIASES: Record<string, Record<string, string>> = {
  twilio: {
    MOCKINGBIRD_TWILIO_ACCOUNT_SID: "TWILIO_ACCOUNT_SID",
    MOCKINGBIRD_TWILIO_AUTH_TOKEN: "TWILIO_AUTH_TOKEN",
  },
}

const results: { name: string; outcome: "parity" | "diverged" | "no credentials" }[] = []
for (const name of wanted) {
  console.log(`\n── ${name} ─────────────────────────────`)
  const aliases = Object.entries(ALIASES[name] ?? {})
    .map(([to, from]) => `${to}="\${${to}:-\${${from}:-}}"`)
    .join(" ")
  const inner = `${aliases ? `export ${aliases}; ` : ""}bun run --cwd packages/service/${name} parity`
  const child = Bun.spawn(
    ["bun", "scripts/vault-run.ts", "--config", "prd", "--", "sh", "-c", inner],
    { cwd: root, stdio: ["inherit", "inherit", "inherit"] },
  )
  const code = await child.exited
  results.push({
    name,
    outcome: code === 0 ? "parity" : code === 2 ? "no credentials" : "diverged",
  })
}

console.log("\nlive parity summary")
for (const { name, outcome } of results) console.log(`  ${name.padEnd(18)} ${outcome}`)
process.exit(results.some((r) => r.outcome === "diverged") ? 1 : 0)
