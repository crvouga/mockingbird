/**
 * Live parity: the same random walk against real Amazon Bedrock Runtime and a fresh mock,
 * canonicalized and diffed. Model output is language, so the contract marks text, token
 * counts and embedding values volatile: the walk compares status codes, error types and
 * response shapes. Credentials come from the environment or Vault `secret/personal/prd`:
 *
 *   MOCKINGBIRD_BEDROCK_ACCESS_KEY_ID
 *   MOCKINGBIRD_BEDROCK_SECRET_ACCESS_KEY
 *   MOCKINGBIRD_BEDROCK_REGION            e.g. us-east-1
 *
 * Every operation is read-only (no side effects), but each call is billed: keep runs small
 * (`FC_NUM_RUNS`). The AgentCore harness needs a deployed harness, so it is skipped unless
 * `--include-harness` is passed.
 */
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-openbao"
import { parity } from "@crvouga/mockingbird-parity"
import { signV4 } from "@crvouga/mockingbird-service"
import { BedrockAPI, document } from "../src/index.js"

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
      provider: "bedrock",
      fields: {
        MOCKINGBIRD_BEDROCK_ACCESS_KEY_ID: "MOCKINGBIRD_BEDROCK_ACCESS_KEY_ID",
        MOCKINGBIRD_BEDROCK_SECRET_ACCESS_KEY: "MOCKINGBIRD_BEDROCK_SECRET_ACCESS_KEY",
        MOCKINGBIRD_BEDROCK_REGION: "MOCKINGBIRD_BEDROCK_REGION",
      },
    },
    { env: process.env, readTokenFile },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`bedrock parity: no AWS credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const region = credentials.values.MOCKINGBIRD_BEDROCK_REGION
const baseUrl = `https://bedrock-runtime.${region}.amazonaws.com`

/**
 * SigV4 for Bedrock: non-S3 services sign the path URI-encoded twice (model ids carry
 * `:` and ARNs `/`), so the signing URL gets one extra round of encoding.
 */
const signedFetch = async (request: Request): Promise<Response> => {
  const url = new URL(request.url)
  const body = new Uint8Array(await request.arrayBuffer())
  const signingUrl = new URL(url)
  signingUrl.pathname = url.pathname
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
  const headers = Object.fromEntries(request.headers)
  const signed = await signV4({
    method: request.method,
    url: signingUrl,
    body,
    region,
    service: url.pathname.startsWith("/harnesses/") ? "bedrock-agentcore" : "bedrock",
    accessKeyId: credentials.values.MOCKINGBIRD_BEDROCK_ACCESS_KEY_ID,
    secretAccessKey: credentials.values.MOCKINGBIRD_BEDROCK_SECRET_ACCESS_KEY,
    headers: { "content-type": headers["content-type"] ?? "application/json" },
  })
  return fetch(url, {
    method: request.method,
    headers: { ...headers, ...signed },
    ...(body.length > 0 ? { body } : {}),
  })
}

const includeHarness = process.argv.includes("--include-harness")
try {
  await parity({
    provider: "bedrock",
    spec: document,
    env: process.env,
    includeUnsafe: true,
    only: [
      "Converse",
      "ConverseStream",
      "InvokeModel",
      ...(includeHarness ? ["InvokeHarness"] : []),
    ],
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host, `bedrock-agentcore.${region}.amazonaws.com`],
      fetch: signedFetch,
      minIntervalMs: 500,
    },
    mock: { create: () => new BedrockAPI() },
    redact: createRedactor([...credentials.secrets]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
