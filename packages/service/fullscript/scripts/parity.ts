/**
 * Live parity: the same random walk against Fullscript's sandbox and a fresh mock,
 * canonicalized and diffed. Credentials come from the environment
 * (`.env.local` locally, repo secrets in the Parity workflow):
 *
 *   MOCKINGBIRD_FULLSCRIPT_API_URL        e.g. https://api-us-snd.fullscript.io
 *   MOCKINGBIRD_FULLSCRIPT_ACCESS_TOKEN   a sandbox practitioner's access token
 *
 * Only reads run by default (clinic, lab orders, events); session grants, token calls and
 * revocation need `--include-unsafe`. The sandbox clinic's lab orders differ from the mock's
 * seed, so order bodies are expected to differ until a corpus is recorded; envelopes, status
 * codes and error shapes are what this run checks first.
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, FullscriptAPI, issueAccessToken } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "fullscript",
      fields: {
        MOCKINGBIRD_FULLSCRIPT_API_URL: "MOCKINGBIRD_FULLSCRIPT_API_URL",
        MOCKINGBIRD_FULLSCRIPT_ACCESS_TOKEN: "MOCKINGBIRD_FULLSCRIPT_ACCESS_TOKEN",
      },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`fullscript parity: no sandbox credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const baseUrl = credentials.values.MOCKINGBIRD_FULLSCRIPT_API_URL.replace(/\/$/, "")
if (!/snd|sandbox|staging/.test(baseUrl) && !process.argv.includes("--allow-production")) {
  console.error(
    "fullscript parity: refusing a non-sandbox Fullscript URL (pass --allow-production)",
  )
  process.exit(2)
}
const realToken = credentials.values.MOCKINGBIRD_FULLSCRIPT_ACCESS_TOKEN
const mockToken = issueAccessToken(
  {
    clientId: "parity",
    practitionerId: "prac_mock_1",
    clinicId: "clinic_mock_1",
    type: "Practitioner",
  },
  Math.floor(Date.now() / 1000),
)

try {
  await parity({
    provider: "fullscript",
    spec: document,
    env: process.env,
    includeUnsafe: process.argv.includes("--include-unsafe"),
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: () => ({ authorization: `Bearer ${realToken}`, accept: "application/json" }),
      minIntervalMs: 500,
    },
    mock: {
      create: () => new FullscriptAPI(),
      headers: () => ({ authorization: `Bearer ${mockToken}`, accept: "application/json" }),
    },
    redact: createRedactor([...credentials.secrets, realToken]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
