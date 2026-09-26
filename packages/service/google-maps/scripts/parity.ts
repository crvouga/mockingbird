/**
 * Live parity: the same random walk against Google Maps Platform and a fresh mock, canonicalized
 * and diffed. The key comes from the environment
 * (`.env.local` locally, repo secrets in the Parity workflow):
 *
 *   GOOGLE_MAPS_API_KEY     a Maps Platform key with Places, Geocoding and
 *                                       Address Validation enabled
 *
 * Every operation is read-only (Address Validation is a POST with no side effects, served from
 * `addressvalidation.googleapis.com`), but each call is billed to the key's
 * project, so walks are small and paced. The Maps JavaScript loader is not compared (parity
 * disabled: the real one is Google's full client library).
 *
 * Expect divergence on addresses outside the QA corpus (the mock synthesizes streets in corpus
 * cities; Google knows the whole country) and on route spellings (Google expands "N Central
 * Ave" to "North Central Avenue" in long_name). For Address Validation compare the verdict class
 * and DPV code: ZIP+4 digits, footnotes and the USPS record are synthesized.
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, GoogleMapsAPI } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "google-maps",
      fields: { GOOGLE_MAPS_API_KEY: "GOOGLE_MAPS_API_KEY" },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`google-maps parity: no Maps Platform key. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const realKey = credentials.values.GOOGLE_MAPS_API_KEY
const baseUrl = "https://maps.googleapis.com"
/** `ValidateAddress` lives on its own host (the spec's path-level `servers`). */
const validationUrl = "https://addressvalidation.googleapis.com"

/**
 * Swap the generated `key=` for the real key on the way out (the spec's key is a placeholder),
 * and send Address Validation to its host.
 */
const withRealKey = (request: Request): Request => {
  const url = new URL(request.url)
  url.searchParams.set("key", realKey)
  const target = url.pathname.startsWith("/v1:")
    ? new URL(url.pathname + url.search, validationUrl)
    : url
  return new Request(target, request)
}

try {
  await parity({
    provider: "google-maps",
    spec: document,
    env: process.env,
    numRuns: 5,
    maxCommands: 8,
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host, new URL(validationUrl).host],
      fetch: (request) => fetch(withRealKey(request)),
      minIntervalMs: 250,
    },
    mock: { create: () => new GoogleMapsAPI() },
    redact: createRedactor([...credentials.secrets, realKey]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
