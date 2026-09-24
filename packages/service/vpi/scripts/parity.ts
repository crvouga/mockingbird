/**
 * Live parity: the same random walk against the real VPI API and a fresh mock, canonicalized
 * and diffed. Credentials come from the environment
 * (`.env.local` locally, repo secrets in the Parity workflow):
 *
 *   MOCKINGBIRD_VPI_API_URL        a VPI sandbox/staging base URL (never production)
 *   MOCKINGBIRD_VPI_EMAIL
 *   MOCKINGBIRD_VPI_PASSWORD
 *
 * By default only safe operations run (auth, catalog, clinic, patients, status lists);
 * saveNewPrescription creates a real draft in the clinic's queue, so it needs `--include-unsafe`.
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, VpiAPI } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "vpi",
      fields: {
        MOCKINGBIRD_VPI_API_URL: "MOCKINGBIRD_VPI_API_URL",
        MOCKINGBIRD_VPI_EMAIL: "MOCKINGBIRD_VPI_EMAIL",
        MOCKINGBIRD_VPI_PASSWORD: "MOCKINGBIRD_VPI_PASSWORD",
      },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`vpi parity: no sandbox credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const baseUrl = credentials.values.MOCKINGBIRD_VPI_API_URL.replace(/\/$/, "")
if (new URL(baseUrl).host === "api.vpicompounding.net") {
  console.error("vpi parity: refusing to run against production (api.vpicompounding.net)")
  process.exit(2)
}
const authenticate = async (fetchFn: (request: Request) => Promise<Response>, url: string) => {
  const response = await fetchFn(
    new Request(`${url}/accounts/authenticate`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        email: credentials.values.MOCKINGBIRD_VPI_EMAIL,
        password: credentials.values.MOCKINGBIRD_VPI_PASSWORD,
        isPatientLogin: false,
      }),
    }),
  )
  if (!response.ok) return undefined
  return ((await response.json()) as { jwtToken?: string }).jwtToken
}

const realToken = await authenticate((r) => fetch(r), baseUrl)
if (!realToken) {
  console.error("vpi parity: authentication against the sandbox failed")
  process.exit(2)
}
const mock = new VpiAPI()
const mockToken = await authenticate((r) => mock.fetch(r), "https://mock.vpi.local")

try {
  await parity({
    provider: "vpi",
    spec: document,
    env: process.env,
    includeUnsafe: process.argv.includes("--include-unsafe"),
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: () => ({ authorization: `Bearer ${realToken}`, accept: "application/json" }),
      minIntervalMs: 250,
    },
    mock: {
      create: () => new VpiAPI(),
      headers: () => ({ authorization: `Bearer ${mockToken}`, accept: "application/json" }),
    },
    redact: createRedactor([...credentials.secrets, realToken]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
