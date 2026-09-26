/**
 * Live parity: the same random walk against the real Paddle sandbox API and a fresh mock,
 * canonicalized and diffed. Credentials come from the environment
 * (`.env.local` locally, repo secrets in the Parity workflow):
 *
 *   PADDLE_API_KEY    a sandbox API key (`pdl_sdbx_apikey_…`); live keys are refused
 *
 * By default only reads run: gets by id, previews, credit balances and auth tokens, plus the
 * per-customer address and business lists (scoped by the customer the walk created). The
 * account-wide lists (`GET /customers`, `/products`, `/prices`, `/transactions`,
 * `/subscriptions`, `/events`) return whatever the sandbox account holds, so they only agree
 * with an empty mock on an empty account: `--all-lists` adds them. Writes create
 * customers, catalog entries and transactions in the sandbox (no money moves) and need
 * `--include-unsafe`.
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, PaddleAPI, supportedOperationIds } from "../src/index.js"

const UNSCOPED_LISTS = [
  "ListCustomers",
  "ListProducts",
  "ListPrices",
  "ListTransactions",
  "ListSubscriptions",
  "ListEvents",
]

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "paddle",
      fields: { PADDLE_API_KEY: "PADDLE_API_KEY" },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`paddle parity: no sandbox credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const apiKey = credentials.values.PADDLE_API_KEY
if (apiKey.startsWith("pdl_live_")) {
  console.error(
    "paddle parity: PADDLE_API_KEY is a live key; only sandbox keys (pdl_sdbx_apikey_…) are accepted",
  )
  process.exit(2)
}

const baseUrl = "https://sandbox-api.paddle.com"
const includeUnsafe = process.argv.includes("--include-unsafe")
const allLists = process.argv.includes("--all-lists")
const only = allLists
  ? undefined
  : supportedOperationIds.filter((id) => !UNSCOPED_LISTS.includes(id))
const headers = (value: string) => ({
  authorization: `Bearer ${value}`,
  accept: "application/json",
})

try {
  await parity({
    provider: "paddle",
    spec: document,
    env: process.env,
    includeUnsafe,
    ...(only ? { only } : {}),
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: () => headers(apiKey),
      minIntervalMs: 250,
    },
    mock: { create: () => new PaddleAPI(), headers: () => headers("pdl_sdbx_apikey_parity") },
    redact: createRedactor([...credentials.secrets]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
