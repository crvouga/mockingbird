/**
 * Live parity: the same random walk against the real Optimal DX partner API and a fresh mock,
 * canonicalized and diffed. Credentials come from the environment
 * (`.env.local` locally, repo secrets in the Parity workflow):
 *
 *   MOCKINGBIRD_ODX_API_URL        e.g. https://odxinstanceresource.azure-api.net/<partner>   (the partner segment is your account's slug)
 *   MOCKINGBIRD_ODX_API_KEY        the ApiKey header value
 *   MOCKINGBIRD_ODX_PRACTICE_ID    OPTIMAL_PRACTICE_ID
 *
 * The vendor was retired 2026-07-22, so these normally do not exist and the script exits 2.
 * By default only safe operations run (labs, elements, patient/test/webhook reads, reports);
 * patient, test and webhook writes need `--include-unsafe`. The spec's fixed practice id is
 * swapped for the real one on the way out.
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, OdxAPI } from "../src/index.js"

const SPEC_PRACTICE = "3f0c0c43-7d2b-4b8e-9a50-9c1f0c6c0001"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "odx",
      fields: {
        MOCKINGBIRD_ODX_API_URL: "MOCKINGBIRD_ODX_API_URL",
        MOCKINGBIRD_ODX_API_KEY: "MOCKINGBIRD_ODX_API_KEY",
        MOCKINGBIRD_ODX_PRACTICE_ID: "MOCKINGBIRD_ODX_PRACTICE_ID",
      },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(
      `odx parity: no Optimal DX credentials (the vendor was retired 2026-07-22). ${error.message}`,
    )
    process.exit(2)
  }
  throw error
}

const baseUrl = credentials.values.MOCKINGBIRD_ODX_API_URL.replace(/\/$/, "")
const apiKey = credentials.values.MOCKINGBIRD_ODX_API_KEY
const practiceId = credentials.values.MOCKINGBIRD_ODX_PRACTICE_ID

/** Rewrite the spec's placeholder practice id into the real one. */
const withRealPractice = (request: Request): Request =>
  new Request(request.url.replace(SPEC_PRACTICE, encodeURIComponent(practiceId)), request)

try {
  await parity({
    provider: "odx",
    spec: document,
    env: process.env,
    includeUnsafe: process.argv.includes("--include-unsafe"),
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: () => ({ ApiKey: apiKey, accept: "*/*" }),
      fetch: (request) => fetch(withRealPractice(request)),
      minIntervalMs: 250,
    },
    mock: {
      create: () => new OdxAPI(),
      headers: () => ({ ApiKey: "parity", accept: "*/*" }),
    },
    redact: createRedactor([...credentials.secrets, practiceId]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
