import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { createRedactor, loadCredentials } from "@crvouga/mockingbird-openbao"
import { parity } from "@crvouga/mockingbird-parity"
import { document, StripeAPI } from "../src/index.js"
import { QA_SURFACE_OPS } from "../src/qa-corpus.js"
import { reshapeQaCommand } from "../src/reshape-qa.js"

const STRIPE_HOST = "api.stripe.com"
const TEST_KEY_PREFIXES = ["sk_test_", "rk_test_"]
const DEFAULT_MIN_INTERVAL_MS = 40

const USAGE = `stripe parity: differential walk against the real Stripe test API

  bun run parity [-- --mode empty] [--only <operationIds>] [--include-unsafe] [--runs N]

Modes:
  empty   (default) compare a fresh mock against the real API over the QA surface allowlist

Live seeding (warm the mock from a real account) is not implemented: the mock can only import
state from another mock instance, and an HTTP oracle cannot hand its account over. Offline
coverage of the same surface lives in stripe.qa.seed.property.test.ts (seeded lockstep between
two mock instances, no credentials).

Credentials: MOCKINGBIRD_STRIPE_SECRET_KEY (sk_test_* / rk_test_*) or the self-hosted Vault.
`

type CliOptions = {
  mode: "empty"
  includeUnsafe: boolean
  only: readonly string[] | undefined
  runs: number | undefined
  help: boolean
}

const parseArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = {
    mode: "empty",
    includeUnsafe: false,
    only: undefined,
    runs: undefined,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--help" || arg === "-h") options.help = true
    else if (arg === "--include-unsafe") options.includeUnsafe = true
    else if (arg === "--mode") {
      const value = argv[index + 1]
      index += 1
      if (value !== undefined && value !== "empty")
        throw new Error(`unsupported mode '${value}': only 'empty' is implemented`)
    } else if (arg === "--only") {
      const value = argv[index + 1]
      index += 1
      options.only = value === undefined ? [] : value.split(",").filter((id) => id !== "")
    } else if (arg === "--runs") {
      const value = argv[index + 1]
      index += 1
      const parsed = Number(value)
      if (Number.isFinite(parsed)) options.runs = Math.trunc(parsed)
    }
  }
  return options
}

const readTokenFile = async () => {
  try {
    return await readFile(join(homedir(), ".vault-token"), "utf8")
  } catch {
    return undefined
  }
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  console.log(USAGE)
  process.exit(0)
}

const credentials = await loadCredentials(
  {
    provider: "stripe",
    fields: { MOCKINGBIRD_STRIPE_SECRET_KEY: "MOCKINGBIRD_STRIPE_SECRET_KEY" },
  },
  { env: process.env, readTokenFile },
)
const secretKey = credentials.values.MOCKINGBIRD_STRIPE_SECRET_KEY
if (!TEST_KEY_PREFIXES.some((prefix) => secretKey.startsWith(prefix))) {
  console.error("stripe parity: refusing to run with a key that is not a test-mode key")
  process.exit(2)
}

const baseUrl = process.env.MOCKINGBIRD_STRIPE_BASE_URL ?? `https://${STRIPE_HOST}`
const authHeaders = {
  authorization: `Bearer ${secretKey}`,
  "stripe-version": document.info.version,
}

try {
  await parity({
    provider: "stripe",
    spec: document,
    env: process.env,
    ...(options.runs === undefined ? {} : { numRuns: options.runs }),
    includeUnsafe: options.includeUnsafe,
    forceInclude: options.only ?? QA_SURFACE_OPS,
    reshapeCommand: reshapeQaCommand,
    real: {
      baseUrl,
      allowedHosts: [STRIPE_HOST],
      headers: () => authHeaders,
      minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
    },
    mock: {
      create: () => new StripeAPI(),
      headers: () => ({ authorization: "Bearer sk_test_mockingbird" }),
    },
    redact: createRedactor(credentials.secrets),
    cleanup: async ({ table, real }) => {
      const del = (path: string) =>
        real.fetch(
          new Request(`${real.baseUrl}${path}`, { method: "DELETE", headers: authHeaders }),
        )
      const archive = (path: string) =>
        real.fetch(
          new Request(`${real.baseUrl}${path}`, {
            method: "POST",
            headers: { ...authHeaders, "content-type": "application/x-www-form-urlencoded" },
            body: "active=false",
          }),
        )
      for (const resource of table.all()) {
        const id = resource.ids.real
        if (id === undefined) continue
        if (resource.type === "subscription") await del(`/v1/subscriptions/${id}`)
        if (resource.type === "price") await archive(`/v1/prices/${id}`)
      }
      for (const resource of table.all()) {
        const id = resource.ids.real
        if (id === undefined) continue
        if (resource.type === "customer") await del(`/v1/customers/${id}`)
        if (resource.type === "product") {
          const response = await del(`/v1/products/${id}`)
          if (!response.ok) await archive(`/v1/products/${id}`)
        }
      }
    },
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
