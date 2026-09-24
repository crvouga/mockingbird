/**
 * Live parity for Lookup v2, the only Twilio surface that is free and contacts no one: basic
 * validation (no `Fields`, which are paid data packages). Verify, Messages and Recordings are
 * never called — they send real SMS or touch real calls.
 *
 * Credentials come from the environment
 * (`.env.local` locally, repo secrets in the Parity workflow):
 *
 *   MOCKINGBIRD_TWILIO_ACCOUNT_SID
 *   MOCKINGBIRD_TWILIO_AUTH_TOKEN
 *
 * Every number is fictional (NANP 555-01xx, Ofcom's 020 7946 0xxx drama range) or a
 * well-known malformed input. Three checks run: a curated table compared byte for byte
 * (`--record` rewrites test/fixtures/lookups.live.json from it), a random walk over the same
 * inputs through the parity runner, and the 401 body for a wrong auth token.
 */
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { createRuntime, document } from "../src/index.js"

/** `[path segment as sent, CountryCode?]`, all fictional or malformed. */
export const LOOKUP_CASES: [string, string?][] = [
  ["+12025550123"],
  ["+13105550142"],
  ["+14155550100"],
  ["+18005550199"],
  ["2025550199"],
  ["12025550123"],
  ["(202)555-0123"],
  ["+1 (202) 555-0123"],
  ["+1 555-0100"],
  ["+15550100"],
  ["5550100"],
  ["5550100", "US"],
  ["20255501"],
  ["+1202555012"],
  ["+120255501234"],
  ["+10025550123"],
  ["+12021550123"],
  ["+15555550100"],
  ["+1202555012a"],
  ["abc"],
  ["+33"],
  ["+1+2025550123"],
  ["+999123456"],
  ["+0012025550123"],
  ["+442079460123"],
  ["+4420794601"],
  ["02079460123", "GB"],
  ["0207946012", "GB"],
  ["2025550123", "CA"],
]

const pathOf = ([raw, country]: [string, string?]) =>
  `/v2/PhoneNumbers/${encodeURIComponent(raw)}${country ? `?CountryCode=${country}` : ""}`

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "twilio",
      fields: {
        MOCKINGBIRD_TWILIO_ACCOUNT_SID: "MOCKINGBIRD_TWILIO_ACCOUNT_SID",
        MOCKINGBIRD_TWILIO_AUTH_TOKEN: "MOCKINGBIRD_TWILIO_AUTH_TOKEN",
      },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`twilio parity: no live credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const sid = credentials.values.MOCKINGBIRD_TWILIO_ACCOUNT_SID as string
const token = credentials.values.MOCKINGBIRD_TWILIO_AUTH_TOKEN as string
const redact = createRedactor([...credentials.secrets, sid])
const basic = (password: string) => `Basic ${btoa(`${sid}:${password}`)}`
const REAL = "https://lookups.twilio.com"
const mock = createRuntime({ accounts: { [sid]: token } })
const MOCK = "http://twilio.mock/lookups"

const call = async (base: string, path: string, password = token) => {
  const send = base === REAL ? fetch : (r: Request) => mock.fetch(r)
  const response = await send(
    new Request(`${base}${path}`, {
      headers: { authorization: basic(password), accept: "application/json" },
    }),
  )
  const text = await response.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // keep text
  }
  return { status: response.status, body }
}

const failures: string[] = []
const recorded: { raw: string; countryCode?: string; status: number; body: unknown }[] = []

// 1. The curated table, byte for byte.
for (const entry of LOOKUP_CASES) {
  const path = pathOf(entry)
  const [real, fake] = [await call(REAL, path), await call(MOCK, path)]
  if (real.status === 401 || real.status === 403) {
    console.error(
      `twilio parity: the account rejected Lookup (${real.status}): ${redact(JSON.stringify(real.body))}`,
    )
    process.exit(1)
  }
  recorded.push({ raw: entry[0], ...(entry[1] ? { countryCode: entry[1] } : {}), ...real })
  const same =
    real.status === fake.status &&
    JSON.stringify(sorted(real.body)) === JSON.stringify(sorted(fake.body))
  console.log(`${same ? "✓" : "✗"} GET ${path} → ${real.status}`)
  if (!same) {
    failures.push(
      `GET ${path}\n  real ${real.status} ${redact(JSON.stringify(sorted(real.body)))}\n  mock ${fake.status} ${JSON.stringify(sorted(fake.body))}`,
    )
  }
  await Bun.sleep(150)
}

// 2. A wrong auth token: Twilio's 20003 body.
{
  const path = pathOf(["+12025550123"])
  const [real, fake] = [
    await call(REAL, path, "wrong-token"),
    await call(MOCK, path, "wrong-token"),
  ]
  const same =
    real.status === fake.status &&
    JSON.stringify(sorted(real.body)) === JSON.stringify(sorted(fake.body))
  console.log(`${same ? "✓" : "✗"} GET ${path} with a wrong token → ${real.status}`)
  if (!same) {
    failures.push(
      `wrong token\n  real ${real.status} ${redact(JSON.stringify(real.body))}\n  mock ${fake.status} ${redact(JSON.stringify(fake.body))}`,
    )
  }
}

if (process.argv.includes("--record")) {
  const file = new URL("../test/fixtures/lookups.live.json", import.meta.url)
  await writeFile(file, `${JSON.stringify(recorded, null, 2)}\n`)
  console.log(`recorded ${recorded.length} live answers to ${file.pathname}`)
}

// 3. A random walk over the same inputs through the parity runner (spec conformance too).
const spec = structuredClone(document)
const lookupPath = spec.paths?.["/lookups/v2/PhoneNumbers/{PhoneNumber}"] as
  | { parameters?: { name: string; schema?: unknown }[] }
  | undefined
for (const parameter of lookupPath?.parameters ?? []) {
  if (parameter.name === "PhoneNumber") {
    parameter.schema = { type: "string", enum: [...new Set(LOOKUP_CASES.map(([raw]) => raw))] }
  }
  // Never pair an input with a region the table did not: a US 555 number read in another
  // region can be somebody's real number.
  if (parameter.name === "CountryCode") {
    parameter.schema = { type: "string", "x-mockingbird-unsupported": { reason: "table only" } }
  }
}
try {
  await parity({
    provider: "twilio",
    spec,
    env: process.env,
    only: ["FetchPhoneNumber"],
    includeUnsafe: false,
    numRuns: 4,
    maxCommands: 5,
    real: {
      baseUrl: REAL,
      allowedHosts: ["lookups.twilio.com"],
      headers: () => ({ authorization: basic(token), accept: "application/json" }),
      fetch: (request) => {
        // The spec's paths carry the mock's /lookups prefix; the real host has none.
        const url = new URL(request.url)
        url.pathname = url.pathname.replace(/^\/lookups(?=\/)/, "")
        return fetch(new Request(url, request))
      },
      minIntervalMs: 250,
    },
    mock: {
      create: () => createRuntime({ accounts: { [sid]: token } }),
      headers: () => ({ authorization: basic(token), accept: "application/json" }),
    },
    redact,
  })
} catch (error) {
  failures.push(`random walk: ${redact(error instanceof Error ? error.message : String(error))}`)
}

if (failures.length > 0) {
  console.error(`\n${failures.length} divergence(s):\n${failures.join("\n\n")}`)
  process.exit(1)
}
console.log("\ntwilio parity: Lookup v2 matches the live API")

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}
