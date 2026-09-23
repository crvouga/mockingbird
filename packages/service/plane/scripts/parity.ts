/**
 * Live parity: the same random walk against a real Plane project and a fresh mock,
 * canonicalized and diffed. Credentials come from the environment or Vault
 * `secret/personal/prd`:
 *
 *   MOCKINGBIRD_PLANE_API_KEY         an API token for a scratch workspace
 *   MOCKINGBIRD_PLANE_WORKSPACE_SLUG  the scratch workspace's slug
 *   MOCKINGBIRD_PLANE_PROJECT_ID      a scratch project (never the real BUGS project)
 *
 * By default only reads run (work items, states, labels, comments, links); creating work
 * items, comments, links and labels needs `--include-unsafe`. The contract pins the parity
 * walk's slug and project id, so the real side's are substituted in the URL.
 */
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-openbao"
import { parity } from "@crvouga/mockingbird-parity"
import { document, PlaneAPI } from "../src/index.js"

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
      provider: "plane",
      fields: {
        MOCKINGBIRD_PLANE_API_KEY: "MOCKINGBIRD_PLANE_API_KEY",
        MOCKINGBIRD_PLANE_WORKSPACE_SLUG: "MOCKINGBIRD_PLANE_WORKSPACE_SLUG",
        MOCKINGBIRD_PLANE_PROJECT_ID: "MOCKINGBIRD_PLANE_PROJECT_ID",
      },
    },
    { env: process.env, readTokenFile },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`plane parity: no sandbox credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const baseUrl = "https://api.plane.so"
const { MOCKINGBIRD_PLANE_API_KEY: key, MOCKINGBIRD_PLANE_WORKSPACE_SLUG: slug } =
  credentials.values
const project = credentials.values.MOCKINGBIRD_PLANE_PROJECT_ID
const PARITY_PATH = "/api/v1/workspaces/geviti/projects/33333333-3333-4333-8333-333333333333/"
const realPath = `/api/v1/workspaces/${encodeURIComponent(slug)}/projects/${encodeURIComponent(project)}/`

try {
  await parity({
    provider: "plane",
    spec: document,
    env: process.env,
    includeUnsafe: process.argv.includes("--include-unsafe"),
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: () => ({ "x-api-key": key, accept: "application/json" }),
      // Plane allows 60 requests per minute per key.
      minIntervalMs: 1_100,
      fetch: (request) => {
        const url = new URL(request.url)
        url.pathname = url.pathname.replace(PARITY_PATH, realPath)
        return fetch(new Request(url, request))
      },
    },
    mock: {
      create: () => new PlaneAPI(),
      headers: () => ({ "x-api-key": "parity", accept: "application/json" }),
    },
    redact: createRedactor([...credentials.secrets]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
