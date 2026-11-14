/**
 * Live parity: the same random walk against a Shopify development store and a fresh emulator,
 * canonicalized and diffed. Credentials come from the environment (`.env.local` locally, repo
 * secrets in the Parity workflow):
 *
 *   SHOPIFY_STORE_DOMAIN   e.g. my-dev-store.myshopify.com
 *   SHOPIFY_ACCESS_TOKEN   an Admin API access token for that development store
 *
 * The walk's documents create orders, draft orders, metafields and webhook subscriptions, so
 * GraphQL only runs with `--include-unsafe`; use a development store, never a live one.
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, ShopifyAPI } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "shopify",
      fields: {
        SHOPIFY_STORE_DOMAIN: "SHOPIFY_STORE_DOMAIN",
        SHOPIFY_ACCESS_TOKEN: "SHOPIFY_ACCESS_TOKEN",
      },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`shopify parity: no development store credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const domain = credentials.values.SHOPIFY_STORE_DOMAIN.replace(/^https?:\/\//, "").replace(
  /\/$/,
  "",
)
const token = credentials.values.SHOPIFY_ACCESS_TOKEN

try {
  await parity({
    provider: "shopify",
    spec: document,
    env: process.env,
    includeUnsafe: process.argv.includes("--include-unsafe"),
    real: {
      baseUrl: `https://${domain}`,
      allowedHosts: [domain],
      headers: () => ({ "x-shopify-access-token": token }),
      minIntervalMs: 500,
    },
    mock: {
      create: () => new ShopifyAPI(),
      headers: () => ({ "x-shopify-access-token": "shpat_mockingbird_test" }),
    },
    redact: createRedactor([...credentials.secrets, token]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
