import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { createRedactor, loadCredentials } from "@crvouga/mockingbird-openbao"
import { parity } from "@crvouga/mockingbird-parity"
import { document, StripeAPI } from "../src/index.js"

const STRIPE_HOST = "api.stripe.com"
const TEST_KEY_PREFIXES = ["sk_test_", "rk_test_"]
const DEFAULT_MIN_INTERVAL_MS = 40

const readTokenFile = async () => {
  try {
    return await readFile(join(homedir(), ".vault-token"), "utf8")
  } catch {
    return undefined
  }
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
