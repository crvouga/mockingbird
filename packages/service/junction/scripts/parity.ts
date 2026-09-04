import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { createRedactor, loadCredentials } from "@crvouga/mockingbird-openbao"
import { parity } from "@crvouga/mockingbird-parity"
import { document, JunctionAPI } from "../src/index.js"

/** Docs: https://docs.junction.com/api-details/junction-api */
const JUNCTION_HOST = "api.sandbox.us.junction.com"
const TEST_KEY_PREFIXES = ["sk_us_", "sk_eu_"]
const DEFAULT_MIN_INTERVAL_MS = 50

const readTokenFile = async () => {
  try {
    return await readFile(join(homedir(), ".vault-token"), "utf8")
  } catch {
    return undefined
  }
}

const credentials = await loadCredentials(
  { provider: "junction", fields: { api_key: "MOCKINGBIRD_JUNCTION_API_KEY" } },
  { env: process.env, readTokenFile },
)
const apiKey = credentials.values.api_key
if (!TEST_KEY_PREFIXES.some((prefix) => apiKey.startsWith(prefix))) {
  console.error("junction parity: refusing to run with a key that is not a sandbox team key")
  process.exit(2)
}

const baseUrl = process.env.MOCKINGBIRD_JUNCTION_BASE_URL ?? `https://${JUNCTION_HOST}`
const authHeaders = { "x-vital-api-key": apiKey }

await parity({
  provider: "junction",
  spec: document,
  env: process.env,
  real: {
    baseUrl,
    allowedHosts: [new URL(baseUrl).host],
    headers: () => authHeaders,
    minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
  },
  mock: {
    create: () => new JunctionAPI(),
    headers: () => ({ "x-vital-api-key": "sk_us_mockingbird" }),
  },
  redact: createRedactor(credentials.secrets),
  cleanup: async ({ table, real }) => {
    for (const resource of table.all()) {
      const id = resource.ids.real
      if (id === undefined || resource.type !== "user") continue
      await real.fetch(
        new Request(`${real.baseUrl}/v2/user/${id}`, {
          method: "DELETE",
          headers: authHeaders,
        }),
      )
    }
  },
})
