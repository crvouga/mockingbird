import { CredentialError, loadCredentials } from "@crvouga/mockingbird-credentials"

let token: string
try {
  const loaded = await loadCredentials(
    { provider: "polar", fields: { token: "POLAR_ACCESS_TOKEN" } },
    { env: process.env },
  )
  token = loaded.values.token as string
} catch (error) {
  if (error instanceof CredentialError) {
    console.error("polar: missing POLAR_ACCESS_TOKEN")
    process.exit(2)
  }
  throw error
}
// Read-only: the user must already be registered with the client. Registration and the OAuth
// exchange are never exercised against the real API.
const response = await fetch(
  "https://www.polaraccesslink.com/v3/exercises?samples=false&zones=false&route=false",
  { headers: { authorization: `Bearer ${token}`, accept: "application/json" } },
)
const body = (await response.json().catch(() => undefined)) as unknown
if (response.status !== 200 || !Array.isArray(body)) {
  console.error(
    `polar: exercise list envelope check failed (HTTP ${response.status}); contents withheld`,
  )
  process.exit(1)
}
console.log(
  "polar: safe exercise list envelope check passed; payloads withheld; OAuth not exercised",
)
