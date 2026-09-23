/**
 * Live parity: the same random walk against the real Wholescripts API and a fresh mock,
 * canonicalized and diffed. Credentials come from the environment or Vault `secret/personal/prd`:
 *
 *   MOCKINGBIRD_WHOLESCRIPTS_API_URL       e.g. https://api.wholescripts.com
 *   MOCKINGBIRD_WHOLESCRIPTS_USERNAME
 *   MOCKINGBIRD_WHOLESCRIPTS_PASSWORD
 *
 * By default only safe operations run (catalogs and status lookups); submit and cancel place
 * and cancel real supplement orders, so they need `--include-unsafe` and a sandbox account.
 */
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-openbao"
import { parity } from "@crvouga/mockingbird-parity"
import { document, WholescriptsAPI } from "../src/index.js"

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
      provider: "wholescripts",
      fields: {
        MOCKINGBIRD_WHOLESCRIPTS_API_URL: "MOCKINGBIRD_WHOLESCRIPTS_API_URL",
        MOCKINGBIRD_WHOLESCRIPTS_USERNAME: "MOCKINGBIRD_WHOLESCRIPTS_USERNAME",
        MOCKINGBIRD_WHOLESCRIPTS_PASSWORD: "MOCKINGBIRD_WHOLESCRIPTS_PASSWORD",
      },
    },
    { env: process.env, readTokenFile },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`wholescripts parity: no live credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const baseUrl = credentials.values.MOCKINGBIRD_WHOLESCRIPTS_API_URL.replace(/\/$/, "")
const realAuth = `Basic ${btoa(
  `${credentials.values.MOCKINGBIRD_WHOLESCRIPTS_USERNAME}:${credentials.values.MOCKINGBIRD_WHOLESCRIPTS_PASSWORD}`,
)}`
const mockAuth = `Basic ${btoa("parity:parity")}`

try {
  await parity({
    provider: "wholescripts",
    spec: document,
    env: process.env,
    includeUnsafe: process.argv.includes("--include-unsafe"),
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: () => ({ authorization: realAuth, accept: "application/json" }),
      minIntervalMs: 250,
    },
    mock: {
      create: () => new WholescriptsAPI(),
      headers: () => ({ authorization: mockAuth, accept: "application/json" }),
    },
    redact: createRedactor([...credentials.secrets, realAuth]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
