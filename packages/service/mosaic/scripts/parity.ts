import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, MosaicAPI } from "../src/index.js"

const readCredentials = () =>
  loadCredentials(
    {
      provider: "mosaic",
      fields: { MOSAIC_API_KEY: "MOSAIC_API_KEY" },
    },
    { env: process.env },
  )
let credentials: Awaited<ReturnType<typeof readCredentials>>
try {
  credentials = await readCredentials()
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`mosaic parity: ${error.message}`)
    process.exit(2)
  }
  throw error
}

const sandbox = "mosaicdx-test-services.com"
const local = "mosaic.local"
const missingLookup = (send: (request: Request) => Promise<Response>) => (request: Request) => {
  const url = new URL(request.url)
  if (url.pathname.startsWith("/api/PatientResults/ReportJson/")) {
    url.pathname = "/api/PatientResults/ReportJson/263"
    url.searchParams.set("reqNum", "0")
  } else {
    url.pathname = url.pathname.replace(/\/[^/]+$/, "/0")
  }
  return send(new Request(url, request))
}
try {
  await parity({
    provider: "mosaic",
    spec: document,
    env: process.env,
    only: ["GetPatient", "GetOrder", "GetReportJson"],
    real: {
      baseUrl: `https://${sandbox}`,
      allowedHosts: [sandbox],
      headers: () => ({ ApiKey: credentials.values.MOSAIC_API_KEY }),
      fetch: missingLookup((request) => fetch(request, { redirect: "error" })),
      minIntervalMs: 500,
    },
    mock: {
      baseUrl: `http://${local}`,
      headers: () => ({ ApiKey: "mockingbird" }),
      create: () => {
        const api = new MosaicAPI()
        return { fetch: missingLookup((request) => api.fetch(request)) }
      },
    },
    redact: createRedactor([...credentials.secrets]),
  })
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
