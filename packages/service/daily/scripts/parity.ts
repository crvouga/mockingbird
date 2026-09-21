/**
 * Live parity: the same random walk against the real Daily.co REST API and a fresh mock,
 * canonicalized and diffed. Credentials come from the environment or Vault
 * `secret/personal/prd`:
 *
 *   MOCKINGBIRD_DAILY_API_KEY     a Daily API key for a test domain
 *
 * By default only safe operations run (get room, presence, meeting tokens); room create,
 * update, delete and eject change the domain, so they need `--include-unsafe`.
 */
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-openbao"
import { parity } from "@crvouga/mockingbird-parity"
import { DailyAPI, document } from "../src/index.js"

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
      provider: "daily",
      fields: { MOCKINGBIRD_DAILY_API_KEY: "MOCKINGBIRD_DAILY_API_KEY" },
    },
    { env: process.env, readTokenFile },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`daily parity: no sandbox credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const baseUrl = "https://api.daily.co"
const apiKey = credentials.values.MOCKINGBIRD_DAILY_API_KEY
const auth = () => ({ authorization: `Bearer ${apiKey}` })

try {
  await parity({
    provider: "daily",
    spec: document,
    env: process.env,
    includeUnsafe: process.argv.includes("--include-unsafe"),
    real: { baseUrl, allowedHosts: ["api.daily.co"], headers: auth, minIntervalMs: 250 },
    mock: { create: () => new DailyAPI(), headers: auth },
    redact: createRedactor([...credentials.secrets]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
