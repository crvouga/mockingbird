/**
 * Live parity: the same random walk against the real FirstPromoter API and a fresh mock,
 * canonicalized and diffed. Credentials come from the environment
 * (`.env.local` locally, repo secrets in the Parity workflow):
 *
 *   MOCKINGBIRD_FIRSTPROMOTER_API_URL      e.g. https://api.firstpromoter.com/api
 *   MOCKINGBIRD_FIRSTPROMOTER_API_KEY
 *   MOCKINGBIRD_FIRSTPROMOTER_ACCOUNT_ID
 *
 * By default only safe operations run (promoter reads, iframe login); creating, updating and
 * archiving promoters and tracking signups change a real account, so they need
 * `--include-unsafe` (use a test account: FirstPromoter has no sandbox mode).
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, FirstPromoterAPI } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "firstpromoter",
      fields: {
        MOCKINGBIRD_FIRSTPROMOTER_API_URL: "MOCKINGBIRD_FIRSTPROMOTER_API_URL",
        MOCKINGBIRD_FIRSTPROMOTER_API_KEY: "MOCKINGBIRD_FIRSTPROMOTER_API_KEY",
        MOCKINGBIRD_FIRSTPROMOTER_ACCOUNT_ID: "MOCKINGBIRD_FIRSTPROMOTER_ACCOUNT_ID",
      },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`firstpromoter parity: no sandbox credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const baseUrl = credentials.values.MOCKINGBIRD_FIRSTPROMOTER_API_URL.replace(/\/$/, "")
const headers = (key: string, account: string) => () => ({
  authorization: `Bearer ${key}`,
  "account-id": account,
  accept: "application/json",
})

try {
  await parity({
    provider: "firstpromoter",
    spec: document,
    env: process.env,
    includeUnsafe: process.argv.includes("--include-unsafe"),
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: headers(
        credentials.values.MOCKINGBIRD_FIRSTPROMOTER_API_KEY,
        credentials.values.MOCKINGBIRD_FIRSTPROMOTER_ACCOUNT_ID,
      ),
      minIntervalMs: 250,
    },
    mock: { create: () => new FirstPromoterAPI(), headers: headers("fp_mock", "acc_mock") },
    redact: createRedactor(credentials.secrets),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
