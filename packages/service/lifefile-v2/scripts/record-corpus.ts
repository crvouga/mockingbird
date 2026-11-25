import { readdir, readFile, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"

type Json = Record<string, unknown>

const [probeRoot, referenceRoot, ...flags] = process.argv.slice(2)
if (!probeRoot || !referenceRoot) {
  console.error(
    "usage: bun scripts/record-corpus.ts <sandbox-probe dir of runs> <reference dir of list replies> [--neutralize Name,Other]",
  )
  process.exit(2)
}
const neutralize = (flags[flags.indexOf("--neutralize") + 1] ?? "")
  .split(",")
  .map((word) => word.trim())
  .filter((word) => flags.includes("--neutralize") && word.length > 0)

const PACKAGE = join(import.meta.dir, "..")
const SYNTHETIC_VENDOR = 10001
const SYNTHETIC_PRACTICE = 900001
const SYNTHETIC_API_USER = 200001
const ORDER_BASE = 50_000_000

const numbers = new Map<number, number>()
const literal = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const strings: [RegExp, string][] = [
  [/SBX-PRA-[0-9A-Z]+/g, "SBX-PRA-SYNTHETIC0001"],
  ...neutralize.flatMap((word): [RegExp, string][] => [
    [new RegExp(literal(word.toUpperCase()), "g"), "SYNTHETIC"],
    [new RegExp(literal(word), "gi"), "Synthetic"],
  ]),
]

const remapNumber = (value: number) => numbers.get(value) ?? value

const VENDOR_CRASH =
  /\S+::\S+\(\): Argument #1 \(\$\w+\) must be of type array, (\w+) given, called in \S+ on line \d+/g

const sanitizeString = (value: string) => {
  let out = value.replace(VENDOR_CRASH, "Server Error: shipping must be an object, $1 given")
  for (const [pattern, replacement] of strings) out = out.replace(pattern, replacement)
  return out.replace(/\b\d{5,9}\b/g, (digits) => String(remapNumber(Number(digits))))
}

const sanitize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sanitize)
  if (typeof value === "number") return remapNumber(value)
  if (typeof value === "string") return sanitizeString(value)
  if (value === null || typeof value !== "object") return value
  const out: Json = {}
  for (const [key, entry] of Object.entries(value as Json)) {
    if (key === "access_token") out[key] = "<token>"
    else out[key] = sanitize(entry)
  }
  return out
}

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8")) as Json

const runs = (await readdir(probeRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

const referenceFiles = [
  "sandbox-statuses",
  "prod-statuses",
  "sandbox-locations",
  "prod-locations",
  "sandbox-shipping-services",
  "prod-shipping-services",
] as const
const reference = Object.fromEntries(
  await Promise.all(
    referenceFiles.map(
      async (name) => [name, await readJson(join(referenceRoot, `${name}.json`))] as const,
    ),
  ),
) as Record<(typeof referenceFiles)[number], { data: Json[] }>

const firstSummary = await readJson(join(probeRoot, runs[0] as string, "summary.json"))
numbers.set(Number(firstSummary.vendor), SYNTHETIC_VENDOR)
numbers.set(Number(firstSummary.practice), SYNTHETIC_PRACTICE)
reference["sandbox-locations"].data.forEach((location, index) => {
  numbers.set(Number(location.id), 100001 + index)
})
reference["prod-locations"].data.forEach((location, index) => {
  numbers.set(Number(location.id), 100101 + index)
})

type Call = {
  run: string
  step: number
  case: string
  note: string
  method: string
  path: string
  vendorHeader: boolean
  auth: "token-valid" | "token-wrong-secret" | "bearer-valid" | "bearer-malformed" | "none"
  waitBeforeMs: number
  body: unknown
  latencyMs: number
  status: number
  rateLimit: { limit: number; remaining: number } | null
  response: unknown
}

const rawCalls: { run: string; file: string; record: Json }[] = []
for (const run of runs) {
  const files = (await readdir(join(probeRoot, run))).filter((f) => /^\d+-.*\.json$/.test(f)).sort()
  for (const file of files)
    rawCalls.push({ run, file, record: await readJson(join(probeRoot, run, file)) })
}

const orderIds = new Set<number>()
for (const { record } of rawCalls) {
  const data = (record.response_body as Json | null)?.data as Json | null | undefined
  if (record.method === "POST" && record.path === "/orders" && typeof data?.orderId === "number") {
    orderIds.add(data.orderId)
  }
  const userId = ((data?.apiUser as Json | undefined)?.id ?? undefined) as number | undefined
  if (typeof userId === "number") numbers.set(userId, SYNTHETIC_API_USER)
}
const sortedOrders = [...orderIds].sort((a, b) => a - b)
sortedOrders.forEach((id, index) => {
  numbers.set(id, ORDER_BASE + 1 + index)
})

const waitFor = (caseName: string) => {
  const match = /-del-wait(\d+)/.exec(caseName)
  return match ? Number(match[1]) * 1000 : 0
}

const authOf = (record: Json): Call["auth"] => {
  const headers = record.request_headers as Record<string, string>
  if (record.path === "/auth/token") {
    return record.case === "token-bad-secret" ? "token-wrong-secret" : "token-valid"
  }
  if (!headers.Authorization) return "none"
  return record.case === "bad-bearer" ? "bearer-malformed" : "bearer-valid"
}

const calls: Call[] = rawCalls.map(({ run, file, record }) => {
  const headers = record.response_headers as Record<string, string>
  const requestHeaders = record.request_headers as Record<string, string>
  const caseName = String(record.case)
  return {
    run,
    step: Number(basename(file).split("-")[0]),
    case: caseName,
    note: String(record.note ?? ""),
    method: String(record.method),
    path: sanitizeString(String(record.path)),
    vendorHeader: requestHeaders["X-Vendor-ID"] !== undefined,
    auth: authOf(record),
    waitBeforeMs: waitFor(caseName),
    body:
      record.path === "/auth/token"
        ? { grant_type: (record.request_body as Json).grant_type }
        : sanitize(record.request_body),
    latencyMs: Number(record.latency_ms),
    status: Number(record.status),
    rateLimit:
      headers["X-RateLimit-Limit"] !== undefined
        ? {
            limit: Number(headers["X-RateLimit-Limit"]),
            remaining: Number(headers["X-RateLimit-Remaining"]),
          }
        : null,
    response: sanitize(record.response_body),
  }
})

const errors = calls
  .filter((call) => call.status >= 400)
  .map((call) => ({
    case: call.case,
    method: call.method,
    path: call.path,
    status: call.status,
    body: call.response,
  }))

const me = calls.find((call) => call.case === "me")
if (!me) throw new Error("the probe has no /auth/me call")
const mePrivileges = ((me.response as Json).data as Json).privileges

const LOCATION_NAMES = [
  "Sandbox Pharmacy North",
  "Sandbox Pharmacy North 2",
  "Sandbox Pharmacy South",
]
const statusesOf = (rows: Json[]) =>
  rows.map((row) => ({ id: String(row.id), label: sanitizeString(String(row.label)) }))
const productionStatusesOf = (rows: Json[], sandbox: readonly { id: string; label: string }[]) => {
  const shared = new Set(sandbox.map((status) => `${status.id}\u0000${status.label}`))
  let synthetic = 0
  return statusesOf(rows).map((status) =>
    shared.has(`${status.id}\u0000${status.label}`)
      ? status
      : { id: status.id, label: `Production Status P-${String(++synthetic).padStart(2, "0")}` },
  )
}
const SYNTHETIC_PRICES = [10, 20, 30] as const
const productionShippingOf = (rows: Json[]) =>
  rows.map((row, index) => ({
    id: 60_001 + index,
    name: `Production Shipping S-${index + 1}`,
    type: row.type,
    price: Number(row.price) === 0 ? 0 : SYNTHETIC_PRICES[index % SYNTHETIC_PRICES.length],
    carrier: row.carrier ?? null,
    carrierKey: row.carrierKey ?? null,
    serviceCode: row.serviceCode ?? null,
    visibleToDoctors: row.visibleToDoctors,
    visibleToPatients: row.visibleToPatients,
    sortPosition: index + 1,
    color: null,
  }))
const sandboxStatuses = statusesOf(reference["sandbox-statuses"].data)
const locationsOf = (rows: Json[], names: readonly string[]) =>
  rows.map((row, index) => ({
    id: remapNumber(Number(row.id)),
    name: names[index] ?? `Pharmacy Location ${index + 1}`,
    shortName: sanitizeString(String(row.shortName)).replace(/Synthetic/g, "Pharmacy"),
  }))

const runtimeCorpus = {
  version: "lifefile-v2-2026-11-24",
  vendorId: SYNTHETIC_VENDOR,
  practice: {
    id: SYNTHETIC_PRACTICE,
    name: "Sandbox API Practice - SBX-PRA-SYNTHETIC0001",
  },
  apiUserId: SYNTHETIC_API_USER,
  privileges: sanitize(mePrivileges),
  catalogs: {
    sandbox: {
      statuses: sandboxStatuses,
      locations: locationsOf(reference["sandbox-locations"].data, LOCATION_NAMES),
      shippingServices: sanitize(reference["sandbox-shipping-services"].data),
    },
    production: {
      statuses: productionStatusesOf(reference["prod-statuses"].data, sandboxStatuses),
      locations: locationsOf(reference["prod-locations"].data, ["Pharmacy Main"]),
      shippingServices: productionShippingOf(reference["prod-shipping-services"].data),
    },
  },
}

const probeCorpus = {
  source: "apitest.lifefile.net (LifeFile API v2 sandbox), 2026-11-24, four sequential probe runs",
  note: "Recorded by a read-and-write sandbox probe with synthetic patients only, then sanitized by scripts/record-corpus.ts: account ids remapped to synthetic ones, tokens and credentials removed, names neutral. The runs share one sandbox account and follow each other in time, so scripts/parity.ts replays them in order in one namespace.",
  calls,
}

await writeFile(
  join(PACKAGE, "corpus", "probe-calls.json"),
  `${JSON.stringify(probeCorpus, null, 2)}\n`,
)
await writeFile(
  join(PACKAGE, "corpus", "live-errors.json"),
  `${JSON.stringify({ source: probeCorpus.source, note: "Every error reply the sandbox gave, sanitized; the acceptance suite asserts the emulator gives the same status and body.", errors }, null, 2)}\n`,
)
await writeFile(
  join(PACKAGE, "corpus", "statuses.json"),
  `${JSON.stringify({ source: "GET /api/v2/statuses on a sandbox and a production account, 2026-11-24; production labels replaced with synthetic ones unless the sandbox has the same code and label", sandbox: runtimeCorpus.catalogs.sandbox.statuses, production: runtimeCorpus.catalogs.production.statuses }, null, 2)}\n`,
)
await writeFile(
  join(PACKAGE, "src", "corpus", "reference.json"),
  `${JSON.stringify(runtimeCorpus, null, 2)}\n`,
)
console.log(
  `wrote ${calls.length} calls, ${errors.length} errors, ${runtimeCorpus.catalogs.sandbox.statuses.length} sandbox and ${runtimeCorpus.catalogs.production.statuses.length} production statuses`,
)
