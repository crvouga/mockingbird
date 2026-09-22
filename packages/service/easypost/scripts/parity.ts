/**
 * Live parity: the same random walk against the real EasyPost API (test mode) and a fresh
 * mock, canonicalized and diffed. Credentials come from the environment or Vault
 * `secret/personal/prd`:
 *
 *   MOCKINGBIRD_EASYPOST_API_KEY    a **test** key (EZTK…); production keys are refused
 *
 * Trackers created in test mode are free and never reach a carrier.
 */
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-openbao"
import { parity } from "@crvouga/mockingbird-parity"
import { document, EasyPostAPI } from "../src/index.js"

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
      provider: "easypost",
      fields: { MOCKINGBIRD_EASYPOST_API_KEY: "MOCKINGBIRD_EASYPOST_API_KEY" },
    },
    { env: process.env, readTokenFile },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`easypost parity: no sandbox credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const key = credentials.values.MOCKINGBIRD_EASYPOST_API_KEY
if (!key.startsWith("EZTK")) {
  console.error("easypost parity: MOCKINGBIRD_EASYPOST_API_KEY must be a test key (EZTK…)")
  process.exit(2)
}
const baseUrl = "https://api.easypost.com"
const auth = { authorization: `Basic ${btoa(`${key}:`)}`, accept: "application/json" }
const mockAuth = { authorization: `Basic ${btoa("EZTKparity:")}`, accept: "application/json" }

try {
  await parity({
    provider: "easypost",
    spec: document,
    env: process.env,
    includeUnsafe: process.argv.includes("--include-unsafe"),
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: () => auth,
      minIntervalMs: 250,
    },
    mock: { create: () => new EasyPostAPI(), headers: () => mockAuth },
    redact: createRedactor([...credentials.secrets]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
