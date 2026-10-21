import { CredentialError, loadCredentials } from "@crvouga/mockingbird-credentials"

let token: string
try {
  const loaded = await loadCredentials(
    { provider: "fitbit", fields: { token: "FITBIT_ACCESS_TOKEN" } },
    { env: process.env },
  )
  token = loaded.values.token as string
} catch (error) {
  if (error instanceof CredentialError) {
    console.error("fitbit: missing FITBIT_ACCESS_TOKEN")
    process.exit(2)
  }
  throw error
}
const get = (path: string) =>
  fetch(`https://api.fitbit.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  })
const profile = await get("/1/user/-/profile.json")
const profileBody = (await profile.json()) as { user?: { encodedId?: unknown } }
const activities = await get(
  "/1/user/-/activities/list.json?afterDate=2026-01-01&sort=asc&limit=1&offset=0",
)
const activitiesBody = (await activities.json()) as {
  activities?: unknown[]
  pagination?: { next?: unknown }
}
if (
  profile.status !== 200 ||
  typeof profileBody.user?.encodedId !== "string" ||
  activities.status !== 200 ||
  !Array.isArray(activitiesBody.activities) ||
  typeof activitiesBody.pagination?.next !== "string"
) {
  console.error(
    `fitbit: envelope check failed (profile HTTP ${profile.status}, activities HTTP ${activities.status}); contents withheld`,
  )
  process.exit(1)
}
console.log(
  "fitbit: safe profile and activity list envelope checks passed; payloads withheld; OAuth mutations not exercised",
)
