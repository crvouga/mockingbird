/**
 * Live parity: the same random walk against a real Formbricks instance and a fresh mock,
 * canonicalized and diffed. Credentials come from the environment
 * (`.env.local` locally, repo secrets in the Parity workflow):
 *
 *   FORMBRICKS_APP_URL      e.g. https://forms.example.com (a NON-production instance)
 *   FORMBRICKS_API_KEY      a management API key for that instance
 *
 * By default only safe operations run (environment state, survey and response reads, the
 * widget script). Creating responses fires the instance's webhooks and creating surveys changes
 * it, so they need `--include-unsafe`. Never point this at a production instance.
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, FormbricksAPI } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "formbricks",
      fields: {
        FORMBRICKS_APP_URL: "FORMBRICKS_APP_URL",
        FORMBRICKS_API_KEY: "FORMBRICKS_API_KEY",
      },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`formbricks parity: no sandbox credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const baseUrl = credentials.values.FORMBRICKS_APP_URL.replace(/\/$/, "")
try {
  await parity({
    provider: "formbricks",
    spec: document,
    env: process.env,
    includeUnsafe: process.argv.includes("--include-unsafe"),
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: () => ({ "x-api-key": credentials.values.FORMBRICKS_API_KEY }),
      minIntervalMs: 250,
    },
    mock: { create: () => new FormbricksAPI(), headers: () => ({ "x-api-key": "fbk_mock" }) },
    redact: createRedactor(credentials.secrets),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
