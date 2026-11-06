/**
 * Kill Bill parity: the same request sequences against a real Kill Bill and a fresh emulator,
 * each in its own new tenant, normalized and diffed.
 *
 *   KILL_BILL_URL       a Kill Bill you run yourself, e.g. http://127.0.0.1:8080 (loopback only
 *                       unless --allow-remote: every run creates a tenant and writes to it, and
 *                       the billing-over-time scenarios move the server-wide test clock to 2030,
 *                       resetting it when they end)
 *   KILL_BILL_USERNAME  admin user (default admin)
 *   KILL_BILL_PASSWORD  admin password (default password)
 *
 *   bun run parity -- [scenario…] [--out <dir>] [--allow-remote]
 *
 * Exits 2 when it cannot run (no KILL_BILL_URL, no server, unknown scenario), 1 on a difference.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { formatDifference, structuralDiff } from "@crvouga/mockingbird-canonicalize"
import { createServer } from "../src/server.js"
import { normalize, runScenario, SCENARIO_NAMES, type Transcript } from "./scenarios.js"

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const option = (name: string) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const outDir = option("--out")
const scenarios = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--out")
const selected = scenarios.length > 0 ? scenarios : SCENARIO_NAMES

const unknown = scenarios.filter((name) => !SCENARIO_NAMES.includes(name))
if (unknown.length > 0) {
  console.error(`kill-bill parity: unknown scenario ${unknown.join(", ")}`)
  console.error(`  scenarios: ${SCENARIO_NAMES.join(", ")}`)
  process.exit(2)
}

const realUrl = process.env.KILL_BILL_URL?.replace(/\/$/, "")
if (!realUrl) {
  console.error("kill-bill parity: set KILL_BILL_URL to a Kill Bill you run (see the header)")
  process.exit(2)
}
const host = new URL(realUrl).hostname
if (!["127.0.0.1", "localhost", "[::1]"].includes(host) && !flag("--allow-remote")) {
  console.error(`kill-bill parity: ${host} is not loopback; pass --allow-remote to write to it`)
  process.exit(2)
}
const username = process.env.KILL_BILL_USERNAME ?? "admin"
const password = process.env.KILL_BILL_PASSWORD ?? "password"

let version: string | undefined
try {
  const info = await fetch(`${realUrl}/1.0/kb/nodesInfo`, {
    headers: { authorization: `Basic ${btoa(`${username}:${password}`)}` },
  })
  if (!info.ok) throw new Error(`nodesInfo answered ${info.status}`)
  version = ((await info.json()) as Array<{ kbVersion?: string }>)[0]?.kbVersion
} catch (error) {
  console.error(
    `kill-bill parity: no Kill Bill at ${realUrl} (${error instanceof Error ? error.message : String(error)})`,
  )
  process.exit(2)
}
console.log(`kill-bill parity: real Kill Bill ${version ?? "unknown version"} at ${realUrl}`)

const mock = await createServer({ plans: [] })
let failed = 0
try {
  for (const scenario of selected) {
    const real = normalize(
      await runScenario({ baseUrl: realUrl, username, password, drainQueues: true }, scenario),
    )
    const emulated = normalize(
      await runScenario(
        { baseUrl: mock.url, username: "admin", password: "password", drainQueues: false },
        scenario,
      ),
    )
    const differences = diff(real, emulated)
    if (outDir) {
      mkdirSync(outDir, { recursive: true })
      writeFileSync(join(outDir, `${scenario}.real.json`), `${JSON.stringify(real, null, 2)}\n`)
      writeFileSync(join(outDir, `${scenario}.mock.json`), `${JSON.stringify(emulated, null, 2)}\n`)
    }
    if (differences.length === 0) {
      console.log(`✓ ${scenario}`)
    } else {
      failed += 1
      console.log(`✗ ${scenario}`)
      for (const line of differences) console.log(`    ${line}`)
    }
  }
} finally {
  await mock.close()
}
process.exit(failed === 0 ? 0 : 1)

function diff(real: Transcript, emulated: Transcript) {
  const out: string[] = []
  const count = Math.max(real.steps.length, emulated.steps.length)
  for (let i = 0; i < count; i += 1) {
    const a = real.steps[i]
    const b = emulated.steps[i]
    const name = a?.name ?? b?.name ?? `step ${i}`
    if (!a || !b) {
      out.push(`${name}: only in ${a ? "real" : "emulator"}`)
      continue
    }
    for (const difference of structuralDiff(
      { status: a.status, body: a.body },
      { status: b.status, body: b.body },
    ))
      out.push(`${name}: ${formatDifference(difference, ["real", "emulator"])}`)
  }
  return out
}
