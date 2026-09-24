/**
 * Live parity: the same random walk against a real OpenObserve instance and a fresh mock,
 * canonicalized and diffed. Credentials come from the environment
 * (`.env.local` locally, repo secrets in the Parity workflow):
 *
 *   MOCKINGBIRD_OTEL_O2_BASE_URL     e.g. https://observe.example.com (a sandbox org, never prod)
 *   MOCKINGBIRD_OTEL_O2_BASIC_AUTH   base64 "user:password" (the shape of O2_BASIC_AUTH)
 *
 * Only the read-only O2 routes run (organizations, streams, schema, _search). The OTLP
 * receiver routes write telemetry into the real org, so they are never walked live.
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, OtelAPI } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "otel",
      fields: {
        MOCKINGBIRD_OTEL_O2_BASE_URL: "MOCKINGBIRD_OTEL_O2_BASE_URL",
        MOCKINGBIRD_OTEL_O2_BASIC_AUTH: "MOCKINGBIRD_OTEL_O2_BASIC_AUTH",
      },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`otel parity: no sandbox credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const baseUrl = credentials.values.MOCKINGBIRD_OTEL_O2_BASE_URL.replace(/\/$/, "")
const auth = credentials.values.MOCKINGBIRD_OTEL_O2_BASIC_AUTH
try {
  await parity({
    provider: "otel",
    spec: document,
    env: process.env,
    only: ["ListOrganizations", "ListStreams", "GetStreamSchema", "Search"],
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: () => ({ authorization: `Basic ${auth}` }),
      minIntervalMs: 250,
    },
    mock: {
      create: () => new OtelAPI(),
      headers: () => ({ authorization: `Basic ${btoa("parity:parity")}` }),
    },
    redact: createRedactor([...credentials.secrets, auth]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
