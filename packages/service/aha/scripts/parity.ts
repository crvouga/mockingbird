/**
 * Live parity: the same random walk against the real AHA partner API (staging) and a fresh
 * mock, canonicalized and diffed. Credentials come from the environment
 * (`.env.local` locally, repo secrets in the Parity workflow):
 *
 *   AHA_API_URL      e.g. https://stage-api.mobileaha.com
 *   AHA_API_KEY
 *   AHA_API_SECRET
 *
 * Both AHA operations create or cancel a real phlebotomy order, so nothing runs unless
 * `--include-unsafe` is passed (and even then, only against a staging URL).
 */
import { createHmac } from "node:crypto"
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { AhaAPI, document } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "aha",
      fields: {
        AHA_API_URL: "AHA_API_URL",
        AHA_API_KEY: "AHA_API_KEY",
        AHA_API_SECRET: "AHA_API_SECRET",
      },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`aha parity: no sandbox credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const includeUnsafe = process.argv.includes("--include-unsafe")
if (!includeUnsafe) {
  console.error(
    "aha parity: every AHA operation creates or cancels a real phlebotomy order; pass --include-unsafe to run against staging.",
  )
  process.exit(2)
}

const baseUrl = credentials.values.AHA_API_URL.replace(/\/$/, "")
if (!/stage|sandbox/i.test(baseUrl)) {
  console.error("aha parity: refusing to walk a non-staging AHA URL")
  process.exit(2)
}
const apiKey = credentials.values.AHA_API_KEY
const apiSecret = credentials.values.AHA_API_SECRET

/** Sign each request the way our consumer does: HMAC over "<key>:<path>:<ms timestamp>". */
const signed =
  (send: (request: Request) => Promise<Response>, key: string, secret: string) =>
  (request: Request) => {
    const path = new URL(request.url).pathname.replace(
      new URL(baseUrl).pathname.replace(/\/$/, ""),
      "",
    )
    const timestamp = Date.now().toString()
    const headers = new Headers(request.headers)
    headers.set("X-API-KEY", key)
    headers.set("X-TIMESTAMP", timestamp)
    headers.set(
      "X-SIGNATURE",
      createHmac("sha256", secret).update(`${key}:${path}:${timestamp}`).digest("base64"),
    )
    return send(new Request(request, { headers }))
  }

try {
  await parity({
    provider: "aha",
    spec: document,
    env: process.env,
    includeUnsafe,
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      fetch: signed((r) => fetch(r), apiKey, apiSecret),
      minIntervalMs: 500,
    },
    mock: {
      create: () => {
        const api = new AhaAPI({ settings: { credentials: [{ apiKey, apiSecret }] } })
        return { fetch: signed((r) => api.fetch(r), apiKey, apiSecret) }
      },
    },
    redact: createRedactor([...credentials.secrets]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
