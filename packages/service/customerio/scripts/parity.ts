/**
 * Live parity: the same random walks against real Customer.io and a fresh mock, canonicalized
 * and diffed. Credentials come from the environment
 * (`.env.local` locally, repo secrets in the Parity workflow):
 *
 *   MOCKINGBIRD_CUSTOMERIO_APP_API_KEY    App API key of a test workspace
 *   MOCKINGBIRD_CUSTOMERIO_CDP_WRITE_KEY  CDP source write key of the same workspace
 *   MOCKINGBIRD_CUSTOMERIO_REGION         optional: "us" (default) or "eu"
 *
 * By default only safe operations run (the transactional-message catalog). Sends and CDP
 * calls change a real workspace and can message real people, so they need `--include-unsafe`
 * (and a workspace whose messages go nowhere).
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { CustomerIoAPI, document } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "customerio",
      fields: {
        MOCKINGBIRD_CUSTOMERIO_APP_API_KEY: "MOCKINGBIRD_CUSTOMERIO_APP_API_KEY",
        MOCKINGBIRD_CUSTOMERIO_CDP_WRITE_KEY: "MOCKINGBIRD_CUSTOMERIO_CDP_WRITE_KEY",
      },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`customerio parity: no sandbox credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const eu = process.env.MOCKINGBIRD_CUSTOMERIO_REGION === "eu"
const includeUnsafe = process.argv.includes("--include-unsafe")
const appKey = credentials.values.MOCKINGBIRD_CUSTOMERIO_APP_API_KEY
const writeKey = credentials.values.MOCKINGBIRD_CUSTOMERIO_CDP_WRITE_KEY
const redact = createRedactor(credentials.secrets)

// The App API and the CDP live on different hosts with different credentials: two runs.
const runs = [
  {
    baseUrl: eu ? "https://api-eu.customer.io" : "https://api.customer.io",
    only: [
      "SendEmail",
      "SendSms",
      "SendInboxMessage",
      "ListTransactionalMessages",
      "GetTransactionalMessage",
    ],
    headers: (key: string) => () => ({ authorization: `Bearer ${key}` }),
    key: appKey,
  },
  {
    baseUrl: eu ? "https://cdp-eu.customer.io" : "https://cdp.customer.io",
    only: ["CdpIdentify", "CdpTrack", "CdpBatch"],
    headers: (key: string) => () => ({ authorization: `Basic ${btoa(`${key}:`)}` }),
    key: writeKey,
  },
]

try {
  for (const run of runs) {
    if (!includeUnsafe && run.only.every((id) => id.startsWith("Cdp"))) continue
    await parity({
      provider: "customerio",
      spec: document,
      env: process.env,
      includeUnsafe,
      only: run.only,
      real: {
        baseUrl: run.baseUrl,
        allowedHosts: [new URL(run.baseUrl).host],
        headers: run.headers(run.key),
        minIntervalMs: 250,
      },
      mock: { create: () => new CustomerIoAPI(), headers: run.headers("mock_key") },
      redact,
    })
  }
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
