/**
 * Live parity: the same random walk against the real legacy Makor AI ("CPG") API and a fresh
 * mock, canonicalized and diffed. Credentials come from the environment or Vault
 * `secret/personal/prd`:
 *
 *   MOCKINGBIRD_MAKOR_CPG_API_URL      e.g. the Railway staging URL (MAKOR_AI_API_URL)
 *   MOCKINGBIRD_MAKOR_CPG_API_KEY      its x-api-key (MAKOR_AI_API_KEY)
 *
 * By default only reads run (care plan, subscription status, orders, summaries, review
 * scripts). Every write reaches staging data or a real LLM (plus-user, subscription cancel,
 * bloodwork webhook, generation), so those need `--include-unsafe`, and even then should only
 * be pointed at throwaway user ids.
 */
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-openbao"
import { parity } from "@crvouga/mockingbird-parity"
import { document, MakorCpgAPI } from "../src/index.js"

const readTokenFile = async () => {
  try {
    return await readFile(join(homedir(), ".vault-token"), "utf8")
  } catch {
    return undefined
  }
}

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "makor-cpg",
      fields: {
        MOCKINGBIRD_MAKOR_CPG_API_URL: "MOCKINGBIRD_MAKOR_CPG_API_URL",
        MOCKINGBIRD_MAKOR_CPG_API_KEY: "MOCKINGBIRD_MAKOR_CPG_API_KEY",
      },
    },
    { env: process.env, readTokenFile },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`makor-cpg parity: no staging credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const baseUrl = credentials.values.MOCKINGBIRD_MAKOR_CPG_API_URL.replace(/\/$/, "")
const key = credentials.values.MOCKINGBIRD_MAKOR_CPG_API_KEY
const unsafe = process.argv.includes("--include-unsafe")
const reads = [
  "GetCurrentCarePlan",
  "GetSubscriptionStatus",
  "GetWholescriptsOrders",
  "GetUserSummary",
  "GetReviewScript",
]

try {
  await parity({
    provider: "makor-cpg",
    spec: document,
    env: process.env,
    includeUnsafe: unsafe,
    ...(unsafe ? {} : { only: reads }),
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: () => ({ "x-api-key": key, accept: "application/json" }),
      minIntervalMs: 250,
    },
    mock: {
      create: () => new MakorCpgAPI(),
      headers: () => ({ "x-api-key": "mk-mock", accept: "application/json" }),
    },
    redact: createRedactor([...credentials.secrets]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
