/**
 * Live parity: the same random walk against the real RxVortex (Strive) sandbox and a fresh mock,
 * canonicalized and diffed. Credentials come from the environment
 * (`.env.local` locally, repo secrets in the Parity workflow):
 *
 *   MOCKINGBIRD_RXVORTEX_API_URL        e.g. https://sandbox-api.rxvortex.com
 *   MOCKINGBIRD_RXVORTEX_CLIENT_ID
 *   MOCKINGBIRD_RXVORTEX_CLIENT_SECRET
 *
 * By default only safe operations run (token, catalog, order lookups); order submit and cancel
 * reach a real pharmacy queue, so they need `--include-unsafe`.
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, RxVortexAPI } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "rxvortex",
      fields: {
        MOCKINGBIRD_RXVORTEX_API_URL: "MOCKINGBIRD_RXVORTEX_API_URL",
        MOCKINGBIRD_RXVORTEX_CLIENT_ID: "MOCKINGBIRD_RXVORTEX_CLIENT_ID",
        MOCKINGBIRD_RXVORTEX_CLIENT_SECRET: "MOCKINGBIRD_RXVORTEX_CLIENT_SECRET",
      },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`rxvortex parity: no sandbox credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const baseUrl = credentials.values.MOCKINGBIRD_RXVORTEX_API_URL.replace(/\/$/, "")
const tokenResponse = await fetch(`${baseUrl}/api/v1/generate-access-token`, {
  method: "POST",
  headers: { accept: "application/json", "content-type": "application/json" },
  body: JSON.stringify({
    client_id: credentials.values.MOCKINGBIRD_RXVORTEX_CLIENT_ID,
    client_secret: credentials.values.MOCKINGBIRD_RXVORTEX_CLIENT_SECRET,
  }),
})
if (!tokenResponse.ok) {
  console.error(`rxvortex parity: token request failed (${tokenResponse.status})`)
  process.exit(2)
}
const payload = (await tokenResponse.json()) as { access_token?: string; token?: string }
const realToken = payload.access_token ?? payload.token ?? ""

const mock = new RxVortexAPI()
const mockToken = (
  (await (
    await mock.fetch(
      new Request("https://mock.rxvortex.local/api/v1/generate-access-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: "parity", client_secret: "parity" }),
      }),
    )
  ).json()) as { access_token: string }
).access_token

try {
  await parity({
    provider: "rxvortex",
    spec: document,
    env: process.env,
    includeUnsafe: process.argv.includes("--include-unsafe"),
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: () => ({ authorization: `Bearer ${realToken}`, accept: "application/json" }),
      minIntervalMs: 250,
    },
    mock: {
      create: () => new RxVortexAPI(),
      headers: () => ({ authorization: `Bearer ${mockToken}`, accept: "application/json" }),
    },
    redact: createRedactor([...credentials.secrets, realToken]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
