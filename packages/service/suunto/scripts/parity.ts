import { CredentialError, loadCredentials } from "@crvouga/mockingbird-credentials"

// Live parity: Suunto needs an approved API Zone subscription key and an access token for a
// Suunto App account with synced watch data. Reads only; the OAuth flow needs a browser.
let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "suunto",
      fields: { token: "SUUNTO_ACCESS_TOKEN", subscriptionKey: "SUUNTO_SUBSCRIPTION_KEY" },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error("suunto: missing SUUNTO_ACCESS_TOKEN or SUUNTO_SUBSCRIPTION_KEY")
    process.exit(2)
  }
  throw error
}
const headers = {
  authorization: `Bearer ${credentials.values.token}`,
  "ocp-apim-subscription-key": credentials.values.subscriptionKey as string,
  accept: "application/json",
}
const response = await fetch("https://cloudapi.suunto.com/v3/workouts/?since=0&limit=1&offset=0", {
  headers,
})
const body = (await response.json().catch(() => undefined)) as
  | { error?: unknown; payload?: unknown }
  | undefined
if (response.status !== 200 || !body || !Array.isArray(body.payload) || body.error) {
  console.error(
    `suunto: workouts envelope check failed (HTTP ${response.status}); contents withheld`,
  )
  process.exit(1)
}
console.log("suunto: safe workouts envelope check passed; payloads withheld; OAuth not exercised")
