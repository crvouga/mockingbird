import { CredentialError, loadCredentials } from "@crvouga/mockingbird-credentials"
import { createRuntime } from "../src/index.js"
import { differences, failures, normalize, REPLAY_CLIENT, replay } from "../test/replay.js"

const runtime = createRuntime({ latency: "none", apiUsers: [REPLAY_CLIENT] })
const outcomes = await replay({
  fetch: (request) => runtime.fetch(request),
  base: "http://lifefile.local",
  namespace: "parity-replay",
})
const failed = failures(outcomes)
for (const outcome of outcomes) {
  const mark = failed.includes(outcome) ? "DIFF" : "ok  "
  console.log(
    `${mark} ${outcome.run}#${String(outcome.step).padStart(2, "0")} ${outcome.method} ${outcome.path} ${outcome.expectedStatus}→${outcome.actualStatus}${outcome.tolerated.length > 0 ? ` (known: ${outcome.tolerated.map((d) => d.path).join(", ")})` : ""}`,
  )
  for (const d of outcome.differences.slice(0, 5)) {
    console.log(`       ${d.path}: recorded ${JSON.stringify(d.expected)} emulator ${JSON.stringify(d.actual)}`)
  }
}
console.log(`lifefile-v2 parity: ${outcomes.length - failed.length}/${outcomes.length} recorded calls match`)
if (failed.length > 0) process.exit(1)

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials({
    provider: "lifefile-v2",
    fields: {
      LIFEFILE_V2_CLIENT_ID: "LIFEFILE_V2_CLIENT_ID",
      LIFEFILE_V2_CLIENT_SECRET: "LIFEFILE_V2_CLIENT_SECRET",
      LIFEFILE_V2_VENDOR_ID: "LIFEFILE_V2_VENDOR_ID",
    },
  }, { env: process.env })
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`lifefile-v2 live parity skipped: ${error.message}`)
    process.exit(2)
  }
  throw error
}

const baseUrl = (process.env.LIFEFILE_V2_API_URL ?? "https://apitest.lifefile.net:10165/api/v2").replace(/\/$/, "")
if (!/apitest\.lifefile\.net/.test(baseUrl)) {
  console.error("lifefile-v2 live parity runs only against the LifeFile sandbox (apitest.lifefile.net)")
  process.exit(2)
}

const { LIFEFILE_V2_CLIENT_ID, LIFEFILE_V2_CLIENT_SECRET, LIFEFILE_V2_VENDOR_ID } = credentials.values as Record<
  string,
  string
>
const live = runtime
const emulatorUser = { clientId: "live-parity", secret: "live-parity" }
await live.fetch(
  new Request("http://lifefile.local/__admin/api-users", {
    method: "PUT",
    headers: { "content-type": "application/json", "x-mockingbird-namespace": "parity-live" },
    body: JSON.stringify(emulatorUser),
  }),
)

const token = async (fetchImpl: (r: Request) => Promise<Response>, base: string, id: string, secret: string, vendor: string) => {
  const response = await fetchImpl(
    new Request(`${base}/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-vendor-id": vendor, accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }).toString(),
    }),
  )
  return ((await response.json()) as { access_token?: string }).access_token ?? ""
}

const emulatorFetch = (request: Request) => {
  const headers = new Headers(request.headers)
  headers.set("x-mockingbird-namespace", "parity-live")
  headers.set("x-vendor-id", "10001")
  return live.fetch(new Request(request, { headers }))
}
const liveToken = await token(fetch, baseUrl, LIFEFILE_V2_CLIENT_ID as string, LIFEFILE_V2_CLIENT_SECRET as string, LIFEFILE_V2_VENDOR_ID as string)
const emulatorToken = await token(emulatorFetch, "http://lifefile.local/api/v2", emulatorUser.clientId, emulatorUser.secret, "10001")
if (!liveToken) {
  console.error("lifefile-v2 live parity: the sandbox refused the token request")
  process.exit(1)
}

const READS = [
  "/ping",
  "/statuses?perPage=50&page=1",
  "/shipping-services?perPage=50",
  "/orders/1",
  "/orders/abc",
  `/orders?${new URLSearchParams({ "filter[rx][uuid]": "7d3cad9d-e7f2-4735-9d2a-d4cd11e320e3" })}`,
] as const

const shape = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.length > 0 ? [shape(value[0])] : []
  if (value === null || typeof value !== "object") return value === null ? null : typeof value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, shape(v)]))
}

let liveFailures = 0
for (const path of READS) {
  const [real, mock] = await Promise.all([
    fetch(new Request(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${liveToken}`, "x-vendor-id": LIFEFILE_V2_VENDOR_ID as string, accept: "application/json" } })),
    emulatorFetch(new Request(`http://lifefile.local/api/v2${path}`, { headers: { authorization: `Bearer ${emulatorToken}`, accept: "application/json" } })),
  ])
  const diffs = differences(shape(normalize(await real.json())), shape(normalize(await mock.json())))
  const ok = real.status === mock.status && diffs.length === 0
  if (!ok) liveFailures++
  console.log(`${ok ? "ok  " : "DIFF"} live GET ${path} ${real.status}→${mock.status}${diffs.length ? ` ${diffs.slice(0, 3).map((d) => d.path).join(", ")}` : ""}`)
}
process.exit(liveFailures > 0 ? 1 : 0)
