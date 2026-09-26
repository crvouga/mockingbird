/**
 * Live parity: the same random walk against the real Flex sandbox and a fresh mock,
 * canonicalized and diffed. Credentials come from the environment
 * (`.env.local` locally, repo secrets in the Parity workflow):
 *
 *   FLEX_API_URL   e.g. https://api.withflex.com
 *   FLEX_API_KEY   a test-mode secret key (fsk_test_…); live keys are refused
 *
 * By default only safe operations run (product, session and setup-intent reads). Creating
 * products, customers and sessions, and refunds, write to the shared sandbox account, so they
 * need `--include-unsafe`.
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, FlexAPI } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "flex",
      fields: {
        FLEX_API_URL: "FLEX_API_URL",
        FLEX_API_KEY: "FLEX_API_KEY",
      },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`flex parity: no sandbox credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const apiKey = credentials.values.FLEX_API_KEY
if (!apiKey.startsWith("fsk_test_")) {
  console.error("flex parity: FLEX_API_KEY must be a test-mode key (fsk_test_…)")
  process.exit(2)
}
const baseUrl = credentials.values.FLEX_API_URL.replace(/\/$/, "")

try {
  await parity({
    provider: "flex",
    spec: document,
    env: process.env,
    includeUnsafe: process.argv.includes("--include-unsafe"),
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: () => ({ authorization: `Bearer ${apiKey}`, accept: "application/json" }),
      minIntervalMs: 250,
    },
    mock: {
      create: () => new FlexAPI(),
      headers: () => ({ authorization: "Bearer fsk_test_parity", accept: "application/json" }),
    },
    redact: createRedactor([...credentials.secrets, apiKey]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
