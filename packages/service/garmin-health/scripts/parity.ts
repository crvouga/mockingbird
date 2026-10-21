import { CredentialError, loadCredentials } from "@crvouga/mockingbird-credentials"

let token: string
try {
  const loaded = await loadCredentials(
    { provider: "garmin-health", fields: { token: "GARMIN_HEALTH_ACCESS_TOKEN" } },
    { env: process.env },
  )
  token = loaded.values.token as string
} catch (error) {
  if (error instanceof CredentialError) {
    console.error("garmin-health: missing GARMIN_HEALTH_ACCESS_TOKEN")
    process.exit(2)
  }
  throw error
}
const response = await fetch("https://apis.garmin.com/wellness-api/rest/user/id", {
  headers: { authorization: `Bearer ${token}`, accept: "application/json" },
})
const body = (await response.json()) as { userId?: unknown }
if (response.status !== 200 || typeof body.userId !== "string") {
  console.error(`garmin-health: user id check failed (HTTP ${response.status}); contents withheld`)
  process.exit(1)
}
console.log(
  "garmin-health: safe user id check passed; backfill, deregistration and webhooks not exercised",
)
