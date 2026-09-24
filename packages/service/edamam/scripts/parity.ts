/**
 * Live parity: the same random walk against api.edamam.com and a fresh mock, canonicalized
 * and diffed. Credentials come from the environment
 * (`.env.local` locally, repo secrets in the Parity workflow):
 *
 *   MOCKINGBIRD_EDAMAM_APP_ID    an application with the Food Database, Nutrition Analysis,
 *   MOCKINGBIRD_EDAMAM_APP_KEY   Recipe Search and Meal Planner APIs enabled
 *
 * The contract pins `app_id=parity&app_key=parity-key` (and the meal planner's path app_id)
 * as its parity vocabulary; the real side's requests are rewritten to the real credentials.
 * Every operation is a read or a stateless computation. Edamam's databases are proprietary
 * and the mock answers from a synthesised corpus, so body differences on food and recipe
 * content are expected until a corpus is recorded; status codes, envelopes and error shapes
 * are what this run checks first.
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, EdamamAPI } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "edamam",
      fields: {
        MOCKINGBIRD_EDAMAM_APP_ID: "MOCKINGBIRD_EDAMAM_APP_ID",
        MOCKINGBIRD_EDAMAM_APP_KEY: "MOCKINGBIRD_EDAMAM_APP_KEY",
      },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`edamam parity: no API credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const baseUrl = "https://api.edamam.com"
const appId = credentials.values.MOCKINGBIRD_EDAMAM_APP_ID
const appKey = credentials.values.MOCKINGBIRD_EDAMAM_APP_KEY

try {
  await parity({
    provider: "edamam",
    spec: document,
    env: process.env,
    includeUnsafe: process.argv.includes("--include-unsafe"),
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: () => ({ accept: "application/json" }),
      minIntervalMs: 1_000,
      fetch: (request) => {
        const url = new URL(request.url)
        if (url.searchParams.get("app_id") === "parity") url.searchParams.set("app_id", appId)
        if (url.searchParams.get("app_key") === "parity-key")
          url.searchParams.set("app_key", appKey)
        url.pathname = url.pathname.replace(
          "/meal-planner/v1/parity/",
          `/meal-planner/v1/${appId}/`,
        )
        const headers = new Headers(request.headers)
        if (url.pathname.includes("/meal-planner/") || url.pathname.includes("/shopping-list/")) {
          headers.set("authorization", `Basic ${btoa(`${appId}:${appKey}`)}`)
        }
        return fetch(
          new Request(url, {
            method: request.method,
            headers,
            body: request.body,
            duplex: "half",
          } as RequestInit),
        )
      },
    },
    mock: { create: () => new EdamamAPI(), headers: () => ({ accept: "application/json" }) },
    redact: createRedactor([...credentials.secrets]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
