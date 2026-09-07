import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { createRedactor, loadCredentials } from "@crvouga/mockingbird-openbao"
import { parity } from "@crvouga/mockingbird-parity"
import { document, GeneByGeneAPI } from "../src/index.js"

/** Docs: https://api.genebygene.com/assets/GxG%20API%20Services%20Developer%20Guide%202022.pdf */
const API_HOST = "staging-api.genebygene.com"
const AUTH_HOST = "staging-auth.genebygene.com"
const DEFAULT_MIN_INTERVAL_MS = 80

const readTokenFile = async () => {
  try {
    return await readFile(join(homedir(), ".vault-token"), "utf8")
  } catch {
    return undefined
  }
}

const credentials = await loadCredentials(
  {
    provider: "genebygene",
    fields: {
      client_id: "MOCKINGBIRD_GENEBYGENE_CLIENT_ID",
      client_secret: "MOCKINGBIRD_GENEBYGENE_CLIENT_SECRET",
    },
  },
  { env: process.env, readTokenFile },
)

const tokenUrl =
  process.env.MOCKINGBIRD_GENEBYGENE_TOKEN_URL ?? `https://${AUTH_HOST}/connect/token`
const baseUrl = process.env.MOCKINGBIRD_GENEBYGENE_BASE_URL ?? `https://${API_HOST}`

const tokenResponse = await fetch(tokenUrl, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "client_credentials",
    client_id: credentials.values.client_id,
    client_secret: credentials.values.client_secret,
  }),
})
if (!tokenResponse.ok) {
  console.error(`genebygene parity: token request failed (${tokenResponse.status})`)
  process.exit(2)
}
const tokenBody = (await tokenResponse.json()) as { access_token: string }
const accessToken = tokenBody.access_token

const authHeaders = { authorization: `Bearer ${accessToken}` }
const allowedHosts = [new URL(baseUrl).host, new URL(tokenUrl).host]

/**
 * Live catalog shapes differ from the mock seed. Exercise the OAuth token endpoint against
 * staging auth, and CRUD orders once product ids are discovered from the real catalog by
 * enabling GetProducts in a follow-up once catalogs are aligned.
 */
try {
  await parity({
    provider: "genebygene",
    spec: document,
    env: process.env,
    only: ["PostConnectToken"],
    real: {
      baseUrl: new URL(tokenUrl).origin,
      allowedHosts,
      headers: () => ({}),
      minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
      fetch: async (request) => {
        // Rewrite mock token path to the staging auth host.
        const url = new URL(request.url)
        if (url.pathname.endsWith("/connect/token")) {
          return fetch(
            new Request(tokenUrl, {
              method: request.method,
              headers: request.headers,
              body: request.body,
              duplex: "half",
            } as RequestInit),
          )
        }
        return fetch(
          new Request(`${baseUrl}${url.pathname}${url.search}`, {
            method: request.method,
            headers: { ...Object.fromEntries(request.headers), ...authHeaders },
            body: request.body,
            duplex: "half",
          } as RequestInit),
        )
      },
    },
    mock: {
      create: () => new GeneByGeneAPI(),
      headers: () => ({}),
    },
    redact: createRedactor([...credentials.secrets, accessToken, credentials.values.client_secret]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
