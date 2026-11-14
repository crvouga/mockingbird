import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, WearablesAPI } from "../src/index.js"

try {
  const credentials = await loadCredentials(
    {
      provider: "open-wearables",
      fields: {
        OPEN_WEARABLES_API_KEY: "OPEN_WEARABLES_API_KEY",
        OPEN_WEARABLES_BASE_URL: "OPEN_WEARABLES_BASE_URL",
      },
    },
    { env: process.env },
  )
  const baseUrl = credentials.values.OPEN_WEARABLES_BASE_URL
  const key = credentials.values.OPEN_WEARABLES_API_KEY
  await parity({
    provider: "open-wearables",
    spec: document,
    env: process.env,
    only: ["ListProviders"],
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: () => ({ "X-Open-Wearables-API-Key": key }),
    },
    mock: {
      create: () => new WearablesAPI(),
      headers: () => ({ "X-Open-Wearables-API-Key": "open_wearables_test" }),
    },
    redact: createRedactor([...credentials.secrets]),
  })
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`open-wearables parity: ${error.message}`)
    process.exit(2)
  }
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
