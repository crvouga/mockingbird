/**
 * Live parity: the same random walk against the real LlamaCloud API and a fresh mock,
 * canonicalized and diffed. Credentials come from the environment
 * (`.env.local` locally, repo secrets in the Parity workflow):
 *
 *   MOCKINGBIRD_LLAMACLOUD_API_KEY      an llx-… key for a sandbox project
 *   MOCKINGBIRD_LLAMACLOUD_BASE_URL     optional, default https://api.cloud.llamaindex.ai
 *
 * Every operation is a read or a write to a pipeline's documents; the walk only writes
 * documents it generates, but it still needs a throwaway pipeline, so by default only the
 * reads run (projects, pipelines, documents, retrieval). `--include-unsafe` adds the writes.
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, LlamaCloudAPI } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "llamacloud",
      fields: { MOCKINGBIRD_LLAMACLOUD_API_KEY: "MOCKINGBIRD_LLAMACLOUD_API_KEY" },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`llamacloud parity: no sandbox credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const baseUrl = (
  process.env.MOCKINGBIRD_LLAMACLOUD_BASE_URL ?? "https://api.cloud.llamaindex.ai"
).replace(/\/$/, "")
const key = credentials.values.MOCKINGBIRD_LLAMACLOUD_API_KEY
const unsafe = process.argv.includes("--include-unsafe")
const reads = [
  "ListProjects",
  "GetProject",
  "SearchPipelines",
  "GetPipeline",
  "RunSearch",
  "ListPipelineDocuments",
  "GetPipelineDocument",
]

try {
  await parity({
    provider: "llamacloud",
    spec: document,
    env: process.env,
    includeUnsafe: unsafe,
    ...(unsafe ? {} : { only: reads }),
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: () => ({ authorization: `Bearer ${key}`, accept: "application/json" }),
      minIntervalMs: 250,
    },
    mock: {
      create: () => new LlamaCloudAPI(),
      headers: () => ({ authorization: "Bearer llx-mock", accept: "application/json" }),
    },
    redact: createRedactor([...credentials.secrets]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
