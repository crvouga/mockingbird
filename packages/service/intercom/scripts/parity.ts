/**
 * Live parity: the same random walk against the real Intercom API and a fresh mock,
 * canonicalized and diffed. Credentials come from the environment
 * (`.env.local` locally, repo secrets in the Parity workflow):
 *
 *   INTERCOM_ACCESS_TOKEN   an access token for a test workspace
 *   INTERCOM_API_URL        optional, default https://api.intercom.io
 *
 * By default only reads run (contact and conversation search, gets, admins, /me). Contact
 * and conversation writes create records and can message real people, so they need
 * `--include-unsafe` and a workspace with no real members.
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, IntercomAPI } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "intercom",
      fields: { INTERCOM_ACCESS_TOKEN: "INTERCOM_ACCESS_TOKEN" },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`intercom parity: no test-workspace credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const baseUrl = (process.env.INTERCOM_API_URL ?? "https://api.intercom.io").replace(/\/$/, "")
const token = credentials.values.INTERCOM_ACCESS_TOKEN
const headers = (value: string) => ({
  authorization: `Bearer ${value}`,
  accept: "application/json",
  "intercom-version": "2.11",
})

try {
  await parity({
    provider: "intercom",
    spec: document,
    env: process.env,
    includeUnsafe: process.argv.includes("--include-unsafe"),
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: () => headers(token),
      minIntervalMs: 250,
    },
    mock: { create: () => new IntercomAPI(), headers: () => headers("ic-mock") },
    redact: createRedactor([...credentials.secrets]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
