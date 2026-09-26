/**
 * Live parity: the same random walk against the Prism Labs sandbox and a fresh mock,
 * canonicalized and diffed. Credentials come from the environment
 * (`.env.local` locally, repo secrets in the Parity workflow):
 *
 *   PRISM_API_URL   e.g. https://sandbox-api.hosted.prismlabs.tech
 *   PRISM_API_KEY   a sandbox key
 *
 * By default only reads run (scans, stage states, results); subject upserts, scan creation
 * and upload URLs need `--include-unsafe` and must use synthetic subject tokens only (never a
 * member's). Binary uploads and asset downloads are parity-disabled.
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, PrismAPI } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "prism",
      fields: {
        PRISM_API_URL: "PRISM_API_URL",
        PRISM_API_KEY: "PRISM_API_KEY",
      },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`prism parity: no sandbox credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const baseUrl = credentials.values.PRISM_API_URL.replace(/\/+$/, "")
if (!/sandbox/.test(baseUrl) && !process.argv.includes("--allow-non-sandbox")) {
  console.error("prism parity: refusing a non-sandbox Prism URL (pass --allow-non-sandbox)")
  process.exit(2)
}
const key = credentials.values.PRISM_API_KEY

try {
  await parity({
    provider: "prism",
    spec: document,
    env: process.env,
    includeUnsafe: process.argv.includes("--include-unsafe"),
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: () => ({ authorization: `Bearer ${key}`, accept: "application/json;v=1" }),
      minIntervalMs: 250,
    },
    mock: {
      create: () => new PrismAPI(),
      headers: () => ({ authorization: "Bearer parity", accept: "application/json;v=1" }),
    },
    redact: createRedactor([...credentials.secrets]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
