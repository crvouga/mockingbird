/**
 * Live parity: the same random walk against a real Payload CMS and a fresh mock, canonicalized
 * and diffed. The mock is first seeded with the live marketing collection (read-only
 * `GET /api/marketing?limit=0`), so both sides answer from the same documents and the walk
 * checks querying, sorting and paging. Configuration comes from the environment
 * (`.env.local` locally, repo secrets in the Parity workflow):
 *
 *   MOCKINGBIRD_PAYLOAD_CMS_API_URL   e.g. https://payload.gogeviti.com
 *
 * Every operation is a read.
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, PayloadCmsAPI, type PayloadDoc } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "payload-cms",
      fields: { MOCKINGBIRD_PAYLOAD_CMS_API_URL: "MOCKINGBIRD_PAYLOAD_CMS_API_URL" },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`payload-cms parity: no CMS configured. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const baseUrl = credentials.values.MOCKINGBIRD_PAYLOAD_CMS_API_URL.replace(/\/$/, "")
const live = await fetch(`${baseUrl}/api/marketing?limit=0&depth=0`, {
  headers: { accept: "application/json" },
})
if (!live.ok) {
  console.error(`payload-cms parity: could not read the live marketing collection (${live.status})`)
  process.exit(2)
}
const { docs } = (await live.json()) as { docs: PayloadDoc[] }

try {
  await parity({
    provider: "payload-cms",
    spec: document,
    env: process.env,
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: () => ({ accept: "application/json" }),
      minIntervalMs: 250,
    },
    mock: {
      create: () => new PayloadCmsAPI({ collections: { marketing: docs } }),
      headers: () => ({ accept: "application/json" }),
    },
    redact: createRedactor([...credentials.secrets]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
