import type { VitalClient } from "@tryvital/vital-node"
import { JunctionAPI } from "../src/index.js"
import { normalize, runSchedulingScenario, shapeOf, withMockFetch } from "./client-parity.js"

const apiKey = process.env.JUNCTION_API_KEY
const sandboxUrl = process.env.JUNCTION_SANDBOX_URL

const diff = (label: string, mockValue: unknown, sandboxValue: unknown): boolean => {
  const same = JSON.stringify(normalize(mockValue)) === JSON.stringify(normalize(sandboxValue))
  if (same) {
    process.stdout.write(`ok   ${label}\n`)
  } else {
    process.stdout.write(`DIFF ${label}\n`)
    process.stdout.write(`  mock:    ${JSON.stringify(normalize(mockValue))?.slice(0, 400)}\n`)
    process.stdout.write(`  sandbox: ${JSON.stringify(normalize(sandboxValue))?.slice(0, 400)}\n`)
  }
  return same
}

/** Shape-only comparison for provider-owned geo surfaces (per-zip data differs by design). */
const diffShape = (label: string, mockValue: unknown, sandboxValue: unknown): boolean => {
  const mockShape = JSON.stringify(shapeOf(mockValue), (_key, value) =>
    typeof value === "number" ? `num:${value}` : value,
  )
  const sandboxShape = JSON.stringify(shapeOf(sandboxValue), (_key, value) =>
    typeof value === "number" ? `num:${value}` : value,
  )
  const same = mockShape === sandboxShape
  if (same) {
    process.stdout.write(`shape ${label}\n`)
  } else {
    process.stdout.write(`SHAPE-DIFF ${label}\n`)
    process.stdout.write(`  mock:    ${mockShape?.slice(0, 400)}\n`)
    process.stdout.write(`  sandbox: ${sandboxShape?.slice(0, 400)}\n`)
  }
  return same
}

const runLiveScenario = async (sandboxClient: VitalClient, clientUserId: string) => {
  const mock = new JunctionAPI({ now: () => 1_700_000_000_000 })
  const mockResult = await withMockFetch(mock, (client) =>
    runSchedulingScenario(client, clientUserId),
  )
  const sandboxResult = await runSchedulingScenario(sandboxClient, clientUserId)
  const labels: Array<[string, keyof typeof mockResult]> = [
    ["user", "user"],
    ["labTest", "labTest"],
    ["labs", "labs"],
    ["markers", "markers"],
    ["areaInfo", "areaInfo"],
    ["pscInfo", "pscInfo"],
    ["cancellationReasons", "cancellationReasons"],
    ["order", "order"],
    ["appointment", "appointment"],
    ["resultMetadata", "resultMetadata"],
  ]
  let ok = true
  for (const [label, key] of labels) {
    const mockValue = mockResult[key]
    const sandboxValue = sandboxResult[key]
    if (key === "appointment" && sandboxValue === undefined) {
      process.stdout.write(`skip appointment (sandbox has no appointment yet)\n`)
      continue
    }
    if (key === "areaInfo" || key === "pscInfo") {
      if (!diffShape(label, mockValue, sandboxValue)) ok = false
      continue
    }
    if (!diff(label, mockValue, sandboxValue)) ok = false
  }
  return ok
}

if (process.env.JUNCTION_LIVE_PARITY !== "1") {
  process.stdout.write("Skipped: set JUNCTION_LIVE_PARITY=1 to run sandbox client parity\n")
} else {
  if (!apiKey || !sandboxUrl) {
    throw new Error("JUNCTION_API_KEY and JUNCTION_SANDBOX_URL are required for live parity")
  }
  const { VitalClient: Client } = await import("@tryvital/vital-node")
  const sandboxClient = new Client({ apiKey, environment: sandboxUrl })
  const ok = await runLiveScenario(sandboxClient, `client-parity-${Date.now()}`)
  process.exitCode = ok ? 0 : 1
}
