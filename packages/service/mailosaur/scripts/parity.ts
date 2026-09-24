/**
 * Live parity: the same random walk against the real Mailosaur API and a fresh mock,
 * canonicalized and diffed. Credentials come from the environment
 * (`.env.local` locally, repo secrets in the Parity workflow):
 *
 *   MOCKINGBIRD_MAILOSAUR_API_KEY      a Mailosaur API key
 *   MOCKINGBIRD_MAILOSAUR_SERVER_ID    the 8-character server (inbox) id to search
 *
 * Every walk's `server=` is pinned to that server on both sides (a random server id is a 404 on
 * the vendor and an empty inbox on the mock). By default only safe operations run (search, list,
 * get); create and delete touch the real inbox, so they need `--include-unsafe`.
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, MailosaurAPI } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "mailosaur",
      fields: {
        MOCKINGBIRD_MAILOSAUR_API_KEY: "MOCKINGBIRD_MAILOSAUR_API_KEY",
        MOCKINGBIRD_MAILOSAUR_SERVER_ID: "MOCKINGBIRD_MAILOSAUR_SERVER_ID",
      },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`mailosaur parity: no credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const baseUrl = "https://mailosaur.com"
const serverId = credentials.values.MOCKINGBIRD_MAILOSAUR_SERVER_ID
const apiKey = credentials.values.MOCKINGBIRD_MAILOSAUR_API_KEY
const authorization = `Basic ${btoa(`${apiKey}:`)}`

/** Pin `server=` to the configured inbox, so both sides search the same (possibly empty) one. */
const pinServer = async (request: Request): Promise<Request> => {
  const url = new URL(request.url)
  if (url.searchParams.has("server")) url.searchParams.set("server", serverId)
  const hasBody = request.method !== "GET" && request.method !== "HEAD"
  return new Request(url, {
    method: request.method,
    headers: request.headers,
    ...(hasBody ? { body: await request.arrayBuffer() } : {}),
  })
}

try {
  await parity({
    provider: "mailosaur",
    spec: document,
    env: process.env,
    includeUnsafe: process.argv.includes("--include-unsafe"),
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: () => ({ authorization, accept: "application/json" }),
      fetch: async (request) => fetch(await pinServer(request)),
      minIntervalMs: 250,
    },
    mock: {
      create: () => {
        const api = new MailosaurAPI()
        return { fetch: async (request: Request) => api.fetch(await pinServer(request)) }
      },
      headers: () => ({ authorization: `Basic ${btoa("parity:")}`, accept: "application/json" }),
    },
    redact: createRedactor([...credentials.secrets, authorization]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
