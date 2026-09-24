import { join } from "node:path"
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, StripeAPI } from "../src/index.js"
import { ACCOUNT_GLOBAL_OPS, QA_SURFACE_OPS } from "../src/qa-corpus.js"
import { compareStripeWebhooks, startStripeWebhookOracle } from "./webhook-oracle.js"

const STRIPE_HOST = "api.stripe.com"
const TEST_KEY_PREFIXES = ["sk_test_", "rk_test_"]
const DEFAULT_MIN_INTERVAL_MS = 40

/** Never walked live: a real webhook endpoint would start receiving the account's events. */
const LIVE_EXCLUDED = [
  "PostWebhookEndpoints",
  "PostWebhookEndpointsWebhookEndpoint",
  "DeleteWebhookEndpointsWebhookEndpoint",
  "GetWebhookEndpointsWebhookEndpoint",
]

const USAGE = `stripe parity: differential walk against the real Stripe test API

  bun run parity [-- --mode empty] [--only <operationIds>] [--include-unsafe] [--runs N] [--no-shrink] [--valid-only] [--no-webhooks]

Modes:
  empty   (default) compare a fresh mock against the real API over the QA surface allowlist

Live seeding (warm the mock from a real account) is not implemented: the mock can only import
state from another mock instance, and an HTTP oracle cannot hand its account over. Offline
coverage of the same surface lives in stripe.qa.seed.property.test.ts (seeded lockstep between
two mock instances, no credentials).

Credentials: MOCKINGBIRD_STRIPE_SECRET_KEY (sk_test_* / rk_test_*) from the environment (.env.local).
Webhook oracle: stripe-cli listen (test mode), forwarded to a local Hono collector.
`

type CliOptions = {
  mode: "empty"
  includeUnsafe: boolean
  only: readonly string[] | undefined
  runs: number | undefined
  shrink: boolean
  /** Only well-formed requests (no malformed bodies, no fabricated ids). */
  validOnly: boolean
  webhooks: boolean
  help: boolean
}

const parseArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = {
    mode: "empty",
    includeUnsafe: false,
    only: undefined,
    runs: undefined,
    shrink: true,
    validOnly: false,
    webhooks: true,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--help" || arg === "-h") options.help = true
    else if (arg === "--include-unsafe") options.includeUnsafe = true
    else if (arg === "--no-shrink") options.shrink = false
    else if (arg === "--valid-only") options.validOnly = true
    else if (arg === "--no-webhooks") options.webhooks = false
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

/**
 * The contract as a well-formed client uses it: every free-form string and every array is
 * non-empty. Stripe reads `""` (and an empty list) as "unset" and reports the first such
 * parameter in an order that differs per endpoint; our consumers never send them, so
 * `--valid-only` walks leave that surface to the mock's own tests.
 */
const wellFormed = <T>(spec: T): T => {
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (typeof node !== "object" || node === null) return
    const schema = node as Record<string, unknown>
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (types.includes("string") && schema.enum === undefined && schema.minLength === undefined)
      schema.minLength = 1
    if (types.includes("array") && schema.minItems === undefined) schema.minItems = 1
    // Drop the `enum: [""]` "unset" branch of unions such as `metadata: object | ""`.
    for (const key of ["anyOf", "oneOf"] as const) {
      const branches = schema[key]
      if (!Array.isArray(branches)) continue
      const kept = branches.filter((branch) => {
        const values = (branch as { enum?: unknown[] }).enum
        return !(Array.isArray(values) && values.every((value) => value === ""))
      })
      if (kept.length > 0) schema[key] = kept
    }
    for (const value of Object.values(schema)) visit(value)
  }
  // Requests only: responses must still conform to the real contract.
  const copy = structuredClone(spec) as { paths?: Record<string, Record<string, unknown>> }
  for (const [path, item] of Object.entries(copy.paths ?? {})) {
    // Search endpoints get queries in the syntax our consumers send (Stripe's parser errors
    // for malformed queries are out of scope for a well-formed walk).
    if (path.endsWith("/search")) {
      const get = item.get as { parameters?: { name?: string; schema?: Record<string, unknown> }[] }
      for (const parameter of get?.parameters ?? []) {
        if (parameter.name === "query" && parameter.schema) {
          parameter.schema.pattern = "^metadata\\['[a-z]{1,8}'\\]:'[a-z0-9]{1,10}'$"
        }
      }
    }
    visit(item.parameters)
    for (const operation of Object.values(item)) {
      if (typeof operation !== "object" || operation === null) continue
      const { parameters, requestBody } = operation as Record<string, unknown>
      visit(parameters)
      visit(requestBody)
    }
  }
  return copy as T
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  console.log(USAGE)
  process.exit(0)
}

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "stripe",
      fields: { MOCKINGBIRD_STRIPE_SECRET_KEY: "MOCKINGBIRD_STRIPE_SECRET_KEY" },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(
      `stripe parity: no test-mode key. Set MOCKINGBIRD_STRIPE_SECRET_KEY (sk_test_…) in .env.local, or run it on GitHub: bun run parity:remote -- stripe. ${error.message}`,
    )
    process.exit(2)
  }
  throw error
}
const secretKey = credentials.values.MOCKINGBIRD_STRIPE_SECRET_KEY
if (!secretKey || !TEST_KEY_PREFIXES.some((prefix) => secretKey.startsWith(prefix))) {
  console.error("stripe parity: refusing to run with a key that is not a test-mode key")
  process.exit(2)
}

const baseUrl = process.env.MOCKINGBIRD_STRIPE_BASE_URL ?? `https://${STRIPE_HOST}`
const authHeaders = {
  authorization: `Bearer ${secretKey}`,
  "stripe-version": document.info.version,
}

/**
 * "empty" mode compares against a fresh mock, so an unfiltered list over objects the sandbox
 * already holds (refunds, charges and events cannot be deleted) is not comparable. Probe each
 * list first and leave out only those with history; every skip is logged.
 */
const LIST_PROBES: Record<string, string> = {
  GetCustomers: "customers",
  GetProducts: "products",
  GetPrices: "prices",
  GetCoupons: "coupons",
  GetPromotionCodes: "promotion_codes",
  GetPaymentIntents: "payment_intents",
  GetSetupIntents: "setup_intents",
  GetCharges: "charges",
  GetRefunds: "refunds",
  GetDisputes: "disputes",
  GetInvoices: "invoices",
  GetInvoiceitems: "invoiceitems",
  GetSubscriptions: "subscriptions",
  GetSubscriptionSchedules: "subscription_schedules",
  GetCheckoutSessions: "checkout/sessions",
  GetEvents: "events",
}
const withHistory: string[] = []
for (const [operationId, path] of Object.entries(LIST_PROBES)) {
  const response = await fetch(`${baseUrl}/v1/${path}?limit=1`, { headers: authHeaders })
  const body = (await response.json().catch(() => ({}))) as { data?: unknown[] }
  if ((body.data?.length ?? 0) > 0) withHistory.push(operationId)
}
if (withHistory.length > 0) {
  console.log(
    `stripe parity: sandbox already holds objects for ${withHistory.join(", ")}; those unfiltered lists are skipped in empty mode`,
  )
}

const webhookOracle = options.webhooks ? await startStripeWebhookOracle(secretKey) : undefined
let webhookCursor = 0
try {
  await parity({
    provider: "stripe",
    spec: options.validOnly ? wellFormed(document) : document,
    env: process.env,
    ...(options.runs === undefined ? {} : { numRuns: options.runs }),
    includeUnsafe: options.includeUnsafe,
    shrink: options.shrink,
    // Malformed requests probe Stripe's per-endpoint validation order; --valid-only compares
    // behaviour on well-formed requests alone.
    ...(options.validOnly
      ? { invalidProbability: 0, missingProbability: 0, deletedRefProbability: 0 }
      : {}),
    // Unsafe operations (money movement, webhook endpoints) only with --include-unsafe.
    ...(options.only !== undefined
      ? { forceInclude: options.only }
      : options.includeUnsafe
        ? { forceInclude: QA_SURFACE_OPS }
        : {}),
    only:
      options.only ??
      QA_SURFACE_OPS.filter(
        (id) =>
          !ACCOUNT_GLOBAL_OPS.includes(id) &&
          !LIVE_EXCLUDED.includes(id) &&
          !withHistory.includes(id),
      ),
    // The mock runs in-process on a busy machine; Stripe's own latency is not what we compare.
    latencyToleranceMs: 1_000,
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
    ...(webhookOracle
      ? {
          webhooks: {
            beforeWalk: async () => {
              webhookCursor = webhookOracle.cursor()
            },
            collectReal: async (_scope: unknown, mockEvents: readonly unknown[]) =>
              webhookOracle.collect(webhookCursor, mockEvents.length),
            collectMock: async (mock: unknown) =>
              (mock as StripeAPI).webhookEvents().map((event) => JSON.parse(event.body) as unknown),
            compare: compareStripeWebhooks,
          },
        }
      : {}),
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
        if (resource.type === "test_clock") await del(`/v1/test_helpers/test_clocks/${id}`)
        if (resource.type === "webhook_endpoint") await del(`/v1/webhook_endpoints/${id}`)
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
  process.exitCode = 1
} finally {
  await webhookOracle?.close()
}
