/**
 * Live parity: the same random walk against Google Maps Platform and a fresh mock, canonicalized
 * and diffed. The key comes from the environment
 * (`.env.local` locally, repo secrets in the Parity workflow):
 *
 *   MOCKINGBIRD_GOOGLE_MAPS_API_KEY     a Maps Platform key with Places + Geocoding enabled
 *
 * Every operation is a read-only GET (no side effects), but each call is billed to the key's
 * project, so walks are small and paced. The Maps JavaScript loader is not compared (parity
 * disabled: the real one is Google's full client library).
 *
 * Expect divergence on addresses outside the QA corpus (the mock synthesizes streets in corpus
 * cities; Google knows the whole country) and on route spellings (Google expands "N Central
 * Ave" to "North Central Avenue" in long_name).
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, GoogleMapsAPI } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "google-maps",
      fields: { MOCKINGBIRD_GOOGLE_MAPS_API_KEY: "MOCKINGBIRD_GOOGLE_MAPS_API_KEY" },
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

const realKey = credentials.values.MOCKINGBIRD_GOOGLE_MAPS_API_KEY
const baseUrl = "https://maps.googleapis.com"

/** Swap the generated `key=` for the real key on the way out (the spec's key is a placeholder). */
const withRealKey = (request: Request): Request => {
  const url = new URL(request.url)
  url.searchParams.set("key", realKey)
  return new Request(url, request)
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
      allowedHosts: [new URL(baseUrl).host],
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
