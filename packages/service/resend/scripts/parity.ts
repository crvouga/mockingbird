/**
 * Live parity: the same random walk against the real Resend API and a fresh mock, canonicalized
 * and diffed. Credentials come from the environment or Vault `secret/personal/prd`:
 *
 *   MOCKINGBIRD_RESEND_API_KEY    a Resend API key (a sending-restricted test key is enough)
 *
 * Only safe operations run (retrieve a sent email, the received-email endpoints, downloads).
 * `POST /emails` is never run live: a random walk would email whatever addresses it generates.
 */
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-openbao"
import { parity } from "@crvouga/mockingbird-parity"
import { document, ResendAPI } from "../src/index.js"

const readTokenFile = async () => {
  try {
    return await readFile(join(homedir(), ".vault-token"), "utf8")
  } catch {
    return undefined
  }
}

if (process.argv.includes("--include-unsafe")) {
  console.error("resend parity: --include-unsafe is refused (it would send real email)")
  process.exit(2)
}

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "resend",
      fields: { MOCKINGBIRD_RESEND_API_KEY: "MOCKINGBIRD_RESEND_API_KEY" },
    },
    { env: process.env, readTokenFile },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`resend parity: no credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const baseUrl = "https://api.resend.com"
const apiKey = credentials.values.MOCKINGBIRD_RESEND_API_KEY

try {
  await parity({
    provider: "resend",
    spec: document,
    env: process.env,
    includeUnsafe: false,
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: () => ({ authorization: `Bearer ${apiKey}`, accept: "application/json" }),
      minIntervalMs: 600,
    },
    mock: {
      create: () => new ResendAPI(),
      headers: () => ({ authorization: "Bearer re_parity", accept: "application/json" }),
    },
    redact: createRedactor([...credentials.secrets]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
