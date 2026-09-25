/**
 * Live parity: the same random walk against Persona's sandbox and a fresh mock, canonicalized
 * and diffed. Credentials come from the environment
 * (`.env.local` locally, repo secrets in the Parity workflow):
 *
 *   PERSONA_API_KEY        a sandbox key (persona_sandbox_…)
 *   PERSONA_API_URL        optional, default https://withpersona.com/api/v1
 *
 * By default only safe operations run (list and get inquiries); creating an inquiry writes to
 * the sandbox, so it needs `--include-unsafe`. The hosted flow pages are never walked.
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, PersonaAPI } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "persona",
      fields: { PERSONA_API_KEY: "PERSONA_API_KEY" },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`persona parity: no sandbox credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const baseUrl = (process.env.PERSONA_API_URL ?? "https://withpersona.com/api/v1").replace(/\/$/, "")
const key = credentials.values.PERSONA_API_KEY
const headers = (token: string) => () => ({
  authorization: `Bearer ${token}`,
  "persona-version": "2023-01-05",
  accept: "application/json",
})

try {
  await parity({
    provider: "persona",
    spec: document,
    env: process.env,
    includeUnsafe: process.argv.includes("--include-unsafe"),
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: headers(key),
      minIntervalMs: 250,
    },
    mock: { create: () => new PersonaAPI(), headers: headers("persona_sandbox_mock") },
    redact: createRedactor([...credentials.secrets, key]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
