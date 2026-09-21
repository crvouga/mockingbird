/**
 * Live parity: the same random walk against a real Formbricks instance and a fresh mock,
 * canonicalized and diffed. Credentials come from the environment or Vault `secret/personal/prd`:
 *
 *   MOCKINGBIRD_FORMBRICKS_APP_URL      e.g. https://forms.example.com (a NON-production instance)
 *   MOCKINGBIRD_FORMBRICKS_API_KEY      a management API key for that instance
 *
 * By default only safe operations run (environment state, survey and response reads, the
 * widget script). Creating responses fires the instance's webhooks and creating surveys changes
 * it, so they need `--include-unsafe`. Never point this at forms.gogeviti.com.
 */
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-openbao"
import { parity } from "@crvouga/mockingbird-parity"
import { document, FormbricksAPI } from "../src/index.js"

const readTokenFile = async () => {
  try {
    return await readFile(join(homedir(), ".vault-token"), "utf8")
  } catch {
    return undefined
  }
}

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "formbricks",
      fields: {
        MOCKINGBIRD_FORMBRICKS_APP_URL: "MOCKINGBIRD_FORMBRICKS_APP_URL",
        MOCKINGBIRD_FORMBRICKS_API_KEY: "MOCKINGBIRD_FORMBRICKS_API_KEY",
      },
    },
    { env: process.env, readTokenFile },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`formbricks parity: no sandbox credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const baseUrl = credentials.values.MOCKINGBIRD_FORMBRICKS_APP_URL.replace(/\/$/, "")
if (new URL(baseUrl).host === "forms.gogeviti.com") {
  console.error("formbricks parity: refusing to run against production (forms.gogeviti.com)")
  process.exit(2)
}

try {
  await parity({
    provider: "formbricks",
    spec: document,
    env: process.env,
    includeUnsafe: process.argv.includes("--include-unsafe"),
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: () => ({ "x-api-key": credentials.values.MOCKINGBIRD_FORMBRICKS_API_KEY }),
      minIntervalMs: 250,
    },
    mock: { create: () => new FormbricksAPI(), headers: () => ({ "x-api-key": "fbk_mock" }) },
    redact: createRedactor(credentials.secrets),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
