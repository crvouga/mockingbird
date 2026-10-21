import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, LifeFileAPI } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "lifefile",
      fields: {
        LIFEFILE_API_URL: "LIFEFILE_API_URL",
        LIFEFILE_USERNAME: "LIFEFILE_USERNAME",
        LIFEFILE_PASSWORD: "LIFEFILE_PASSWORD",
        LIFEFILE_VENDOR_ID: "LIFEFILE_VENDOR_ID",
        LIFEFILE_LOCATION_ID: "LIFEFILE_LOCATION_ID",
        LIFEFILE_API_NETWORK_ID: "LIFEFILE_API_NETWORK_ID",
      },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`lifefile parity: no sandbox credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}
// Every current operation can submit or cancel a prescription. Explicit sandbox opt-in only.
if (!process.argv.includes("--include-unsafe")) {
  console.error(
    "lifefile parity: no safe read operations; use an isolated sandbox and --include-unsafe",
  )
  process.exit(2)
}
const values = credentials.values
const baseUrl = values.LIFEFILE_API_URL.replace(/\/+$/, "")
const auth = {
  authorization: `Basic ${btoa(`${values.LIFEFILE_USERNAME}:${values.LIFEFILE_PASSWORD}`)}`,
  "x-vendor-id": values.LIFEFILE_VENDOR_ID,
  "x-location-id": values.LIFEFILE_LOCATION_ID,
  "x-api-network-id": values.LIFEFILE_API_NETWORK_ID,
}
await parity({
  provider: "lifefile",
  spec: document,
  env: process.env,
  includeUnsafe: true,
  real: { baseUrl, allowedHosts: [new URL(baseUrl).host], headers: () => auth, minIntervalMs: 250 },
  mock: { create: () => new LifeFileAPI(), headers: () => auth },
  redact: createRedactor(credentials.secrets),
})
