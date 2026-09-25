/**
 * Live parity: the same random walk against Healthie's staging API and a fresh mock,
 * canonicalized and diffed. Credentials come from the environment
 * (`.env.local` locally, repo secrets in the Parity workflow):
 *
 *   HEALTHIE_API_URL   e.g. https://staging-api.gethealthie.com
 *   HEALTHIE_API_KEY   an organization API key for a sandbox org
 *
 * The walk's documents include mutations (signIn issues keys, updateClient writes metadata,
 * createFolder creates folders), so GraphQL only runs with `--include-unsafe`; by default only
 * the download route (signature checks) is compared. Healthie is legacy for us (catalog S23):
 * check whether a live run is worth it before wiring credentials.
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { DEFAULT_SETTINGS, document, HealthieAPI } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "healthie",
      fields: {
        HEALTHIE_API_URL: "HEALTHIE_API_URL",
        HEALTHIE_API_KEY: "HEALTHIE_API_KEY",
      },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`healthie parity: no sandbox credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const baseUrl = credentials.values.HEALTHIE_API_URL.replace(/\/graphql$/, "").replace(/\/$/, "")
const realKey = credentials.values.HEALTHIE_API_KEY
const mockKey = DEFAULT_SETTINGS.orgApiKeys[0] as string

try {
  await parity({
    provider: "healthie",
    spec: document,
    env: process.env,
    includeUnsafe: process.argv.includes("--include-unsafe"),
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: () => ({ authorization: `Basic ${realKey}`, authorizationsource: "API" }),
      minIntervalMs: 500,
    },
    mock: {
      create: () => new HealthieAPI(),
      headers: () => ({ authorization: `Basic ${mockKey}`, authorizationsource: "API" }),
    },
    redact: createRedactor([...credentials.secrets, realKey]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
