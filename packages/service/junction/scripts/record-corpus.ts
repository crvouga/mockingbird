import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { loadCredentials } from "@crvouga/mockingbird-openbao"
import type { SeedCacheEntry } from "@crvouga/mockingbird-parity"
import type { ExpectedResult, LabTestRecord } from "../src/catalog.js"
import { type PrefetchTarget, recordObservation, recordSandboxCorpus } from "../src/prefetch.js"
import { SEALED_CORPUS_VERSION, type SealedCorpus } from "../src/sealed-corpus.js"
import { expectedFromMarkersResponse, mapLabTest, type SeedSource } from "../src/seed-from.js"

const TEST_KEY_PREFIXES = ["sk_us_", "sk_eu_"]
const DEFAULT_BASE_URL = "https://api.sandbox.tryvital.io"
const MIN_INTERVAL_MS = 50

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

const parseArgs = (argv: readonly string[]) => {
  let out: string | undefined
  let force = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--force") {
      force = true
      continue
    }
    if (arg === "--out") {
      out = argv[index + 1]
      index += 1
    }
  }
  return { out, force }
}

const readTokenFile = async () => {
  try {
    return await readFile(join(homedir(), ".vault-token"), "utf8")
  } catch {
    return undefined
  }
}

const outPath = parseArgs(Bun.argv.slice(2))
const target = outPath.out ?? join(import.meta.dir, "../corpus/sandbox-sealed.json")
if (!outPath.force) {
  const exists = await access(target).then(
    () => true,
    () => false,
  )
  if (exists) {
    console.log(`${target} exists; pass --force to overwrite`)
    process.exit(1)
  }
}

const credentials = await loadCredentials(
  {
    provider: "junction",
    fields: { MOCKINGBIRD_JUNCTION_API_KEY: "MOCKINGBIRD_JUNCTION_API_KEY" },
  },
  { env: Bun.env, readTokenFile },
)
const apiKey = credentials.values.MOCKINGBIRD_JUNCTION_API_KEY
if (!TEST_KEY_PREFIXES.some((prefix) => apiKey.startsWith(prefix))) {
  console.error("refusing to run with a key that is not a sandbox team key")
  process.exit(2)
}

const baseUrl = process.env.MOCKINGBIRD_JUNCTION_BASE_URL ?? DEFAULT_BASE_URL
const authHeaders = { "x-vital-api-key": apiKey }
const real: PrefetchTarget = {
  baseUrl,
  fetch: (request) => fetch(request),
  headers: () => authHeaders,
}
const source: SeedSource = {
  baseUrl,
  fetch: (request) => fetch(request),
  headers: authHeaders,
}

const getCache = new Map<string, SeedCacheEntry>()
const { labIds } = await recordSandboxCorpus({ real, getCache, minIntervalMs: MIN_INTERVAL_MS })
console.log(`recorded area/PSC corpus for ${String(labIds.length)} labs`)

const labTests: LabTestRecord[] = []
let cursor: string | null = null
for (;;) {
  const path =
    cursor === null ? "/v3/lab_test" : `/v3/lab_test?next_cursor=${encodeURIComponent(cursor)}`
  const body = asRecord(await recordObservation(real, "GET", path, getCache))
  const data = body?.data
  if (Array.isArray(data)) {
    for (const entry of data) {
      const test = mapLabTest(entry)
      if (test) labTests.push(test)
    }
  }
  cursor = typeof body?.next_cursor === "string" ? body.next_cursor : null
  if (cursor === null) break
  await sleep(MIN_INTERVAL_MS)
}

const rawLabs = await recordObservation(real, "GET", "/v3/lab_tests/labs", getCache)
const labs: Record<string, unknown>[] = []
if (Array.isArray(rawLabs)) {
  for (const entry of rawLabs) {
    const record = asRecord(entry)
    if (record) labs.push(record)
  }
}
await sleep(MIN_INTERVAL_MS)

const expectedResults: Record<string, ExpectedResult[]> = {}
for (const test of labTests) {
  await recordObservation(real, "GET", `/v3/lab_tests/${test.id}/markers`, getCache)
  expectedResults[test.id] = await expectedFromMarkersResponse(source, test)
  await sleep(MIN_INTERVAL_MS)
}

const rawLabAccounts = await recordObservation(real, "GET", "/v3/lab_test/lab_account", getCache)
const labAccounts: Record<string, unknown>[] = []
if (Array.isArray(rawLabAccounts)) {
  for (const entry of rawLabAccounts) {
    const record = asRecord(entry)
    if (record) labAccounts.push(record)
  }
}

const observations = Object.fromEntries(
  [...getCache.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
)
const corpus: SealedCorpus = {
  version: SEALED_CORPUS_VERSION,
  recordedAt: new Date().toISOString(),
  source: baseUrl,
  observations,
  catalog: { labTests, labs, expectedResults },
  labAccounts,
}
const json = JSON.stringify(corpus, null, 2)
await mkdir(dirname(target), { recursive: true })
await writeFile(target, json)
console.log(
  `sealed ${String(Object.keys(observations).length)} observations (${String(Buffer.byteLength(json))} bytes), ${String(labTests.length)} lab tests, ${String(labs.length)} labs, ${String(labAccounts.length)} lab accounts`,
)
