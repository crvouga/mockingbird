/**
 * Live parity: the same random walk against the real Pharmetika provider portal and a fresh
 * mock, canonicalized and diffed. Credentials come from the environment
 * (`.env.local` locally, repo secrets in the Parity workflow):
 *
 *   PHARMETIKA_API_URL      e.g. https://testreviverx.pharmetika.com
 *   PHARMETIKA_API_TOKEN    the x-pmk-authentication-token
 *
 * By default only safe operations run (clinic and patient lists, validate, order lookup, the
 * template catalog). Patient create, submit, EPCS prepare and cancel reach a real pharmacy
 * queue, so they need `--include-unsafe` — never run that against production.
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, PharmetikaAPI } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "pharmetika",
      fields: {
        PHARMETIKA_API_URL: "PHARMETIKA_API_URL",
        PHARMETIKA_API_TOKEN: "PHARMETIKA_API_TOKEN",
      },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`pharmetika parity: no sandbox credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const baseUrl = credentials.values.PHARMETIKA_API_URL.replace(/\/$/, "")
const realToken = credentials.values.PHARMETIKA_API_TOKEN

try {
  await parity({
    provider: "pharmetika",
    spec: document,
    env: process.env,
    includeUnsafe: process.argv.includes("--include-unsafe"),
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: () => ({ "x-pmk-authentication-token": realToken, accept: "application/json" }),
      minIntervalMs: 250,
    },
    mock: {
      create: () => new PharmetikaAPI(),
      headers: () => ({ "x-pmk-authentication-token": "parity", accept: "application/json" }),
    },
    redact: createRedactor([...credentials.secrets, realToken]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
