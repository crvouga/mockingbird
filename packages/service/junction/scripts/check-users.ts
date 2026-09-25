import { loadCredentials } from "@crvouga/mockingbird-credentials"

const credentials = await loadCredentials(
  {
    provider: "junction",
    fields: { JUNCTION_API_KEY: "JUNCTION_API_KEY" },
  },
  { env: Bun.env },
)
const apiKey = credentials.values.JUNCTION_API_KEY
const base = Bun.env.JUNCTION_BASE_URL ?? "https://api.sandbox.us.junction.com"
const r = await fetch(`${base}/v2/user?offset=0&limit=1`, {
  headers: { "x-vital-api-key": apiKey },
})
const payload = (await r.json()) as { users?: Array<Record<string, unknown>>; total?: number }
console.log("total:", payload.total)
for (const u of payload.users ?? []) {
  console.log(u.client_user_id, u.user_id, u.created_at ?? "", u.team_id ?? "")
}
