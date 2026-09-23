/**
 * Live parity: the same random walk against the real Klaviyo API and a fresh mock,
 * canonicalized and diffed. Credentials come from the environment or Vault `secret/personal/prd`:
 *
 *   MOCKINGBIRD_KLAVIYO_API_KEY   a private key (pk_…) of a sandbox / test account
 *
 * By default only safe operations run (event reads); creating events writes to a real
 * account (and can trigger flows that email real people), so it needs `--include-unsafe`.
 */
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-openbao"
import { parity } from "@crvouga/mockingbird-parity"
import { document, KLAVIYO_REVISION, KlaviyoAPI } from "../src/index.js"

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
      provider: "klaviyo",
      fields: { MOCKINGBIRD_KLAVIYO_API_KEY: "MOCKINGBIRD_KLAVIYO_API_KEY" },
    },
    { env: process.env, readTokenFile },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`klaviyo parity: no sandbox credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const key = credentials.values.MOCKINGBIRD_KLAVIYO_API_KEY
const headers = () => ({
  authorization: `Klaviyo-API-Key ${key}`,
  revision: KLAVIYO_REVISION,
  accept: "application/json",
})

try {
  await parity({
    provider: "klaviyo",
    spec: document,
    env: process.env,
    includeUnsafe: process.argv.includes("--include-unsafe"),
    real: {
      baseUrl: "https://a.klaviyo.com",
      allowedHosts: ["a.klaviyo.com"],
      headers,
      minIntervalMs: 250,
    },
    mock: {
      create: () => new KlaviyoAPI(),
      headers: () => ({ ...headers(), authorization: "Klaviyo-API-Key pk_mock" }),
    },
    redact: createRedactor(credentials.secrets),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
