/**
 * Live parity: the same random walk against Gene by Gene staging (Nucleus API v2) and a fresh
 * mock, canonicalized and diffed. Credentials come from the environment or Vault
 * `secret/personal/prd`:
 *
 *   MOCKINGBIRD_GENEBYGENE_CLIENT_ID
 *   MOCKINGBIRD_GENEBYGENE_CLIENT_SECRET
 *   MOCKINGBIRD_GENEBYGENE_BASE_URL   optional, default https://staging-api.genebygene.com
 *   MOCKINGBIRD_GENEBYGENE_TOKEN_URL  optional, default https://staging-auth.genebygene.com/connect/token
 *
 * By default only safe operations run (token, catalog, lists, lookups, shipping quotes); order
 * placement, cancels, attribute patches and subscription changes touch a real tenant and need
 * `--include-unsafe`.
 */
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-openbao"
import { parity } from "@crvouga/mockingbird-parity"
import { document, GeneByGeneAPI } from "../src/index.js"

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
      provider: "genebygene",
      fields: {
        MOCKINGBIRD_GENEBYGENE_CLIENT_ID: "MOCKINGBIRD_GENEBYGENE_CLIENT_ID",
        MOCKINGBIRD_GENEBYGENE_CLIENT_SECRET: "MOCKINGBIRD_GENEBYGENE_CLIENT_SECRET",
      },
    },
    { env: process.env, readTokenFile },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`genebygene parity: no staging credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const tokenUrl =
  process.env.MOCKINGBIRD_GENEBYGENE_TOKEN_URL ??
  "https://staging-auth.genebygene.com/connect/token"
const baseUrl = (
  process.env.MOCKINGBIRD_GENEBYGENE_BASE_URL ?? "https://staging-api.genebygene.com"
).replace(/\/$/, "")

const requestToken = (
  target: (request: Request) => Promise<Response>,
  clientId: string,
  secret: string,
) =>
  target(
    new Request(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: secret,
      }),
    }),
  )

const tokenResponse = await requestToken(
  (r) => fetch(r),
  credentials.values.MOCKINGBIRD_GENEBYGENE_CLIENT_ID ?? "",
  credentials.values.MOCKINGBIRD_GENEBYGENE_CLIENT_SECRET ?? "",
)
if (!tokenResponse.ok) {
  console.error(`genebygene parity: token request failed (${tokenResponse.status})`)
  process.exit(2)
}
const realToken = ((await tokenResponse.json()) as { access_token: string }).access_token

const mockToken = (
  (await (await requestToken((r) => new GeneByGeneAPI().fetch(r), "parity", "parity")).json()) as {
    access_token: string
  }
).access_token

try {
  await parity({
    provider: "genebygene",
    spec: document,
    env: process.env,
    includeUnsafe: process.argv.includes("--include-unsafe"),
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host, new URL(tokenUrl).host],
      headers: () => ({ authorization: `Bearer ${realToken}`, accept: "application/json" }),
      // GxG staging is shared and slow: stay under our client's own 2 rps budget.
      minIntervalMs: 500,
      fetch: (request) => {
        // The token operation lives on the auth host.
        const url = new URL(request.url)
        if (url.pathname.endsWith("/connect/token")) return fetch(new Request(tokenUrl, request))
        return fetch(request)
      },
    },
    mock: {
      create: () => new GeneByGeneAPI(),
      headers: () => ({ authorization: `Bearer ${mockToken}`, accept: "application/json" }),
    },
    redact: createRedactor([...credentials.secrets, realToken]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
