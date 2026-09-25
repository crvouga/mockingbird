/**
 * Live parity: the same random walk against real Amazon Polly and a fresh mock. Audio bytes
 * compare as "present" (they are synthetic here), so the walk checks status codes, error
 * types and headers. Credentials come from the environment
 * (`.env.local` locally, repo secrets in the Parity workflow):
 *
 *   AWS_SPEECH_ACCESS_KEY_ID
 *   AWS_SPEECH_SECRET_ACCESS_KEY
 *   AWS_SPEECH_REGION            e.g. us-east-1
 *
 * Only Polly `SynthesizeSpeech` runs by default (billed per character; keep `FC_NUM_RUNS`
 * small). `--include-unsafe` adds Transcribe batch, which starts real (billed) jobs. The
 * HTTP/2 duplex streams are covered by the SDK tests, not by random walks.
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { signV4 } from "@crvouga/mockingbird-service"
import { document, SpeechAPI } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "aws-speech",
      fields: {
        AWS_SPEECH_ACCESS_KEY_ID: "AWS_SPEECH_ACCESS_KEY_ID",
        AWS_SPEECH_SECRET_ACCESS_KEY: "AWS_SPEECH_SECRET_ACCESS_KEY",
        AWS_SPEECH_REGION: "AWS_SPEECH_REGION",
      },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`aws-speech parity: no AWS credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const region = credentials.values.AWS_SPEECH_REGION
const polly = `https://polly.${region}.amazonaws.com`
const transcribe = `https://transcribe.${region}.amazonaws.com`

/** SigV4-sign each request; Transcribe batch goes to its own host with the JSON 1.1 type. */
const signedFetch = async (request: Request): Promise<Response> => {
  const incoming = new URL(request.url)
  const batch = incoming.pathname === "/"
  const url = new URL(`${incoming.pathname}${incoming.search}`, batch ? transcribe : polly)
  const body = new Uint8Array(await request.arrayBuffer())
  const headers: Record<string, string> = {
    ...Object.fromEntries(request.headers),
    "content-type": batch
      ? "application/x-amz-json-1.1"
      : (request.headers.get("content-type") ?? "application/json"),
  }
  const signed = await signV4({
    method: request.method,
    url,
    body,
    region,
    service: batch ? "transcribe" : "polly",
    accessKeyId: credentials.values.AWS_SPEECH_ACCESS_KEY_ID,
    secretAccessKey: credentials.values.AWS_SPEECH_SECRET_ACCESS_KEY,
    headers,
  })
  return fetch(url, {
    method: request.method,
    headers: { ...headers, ...signed },
    ...(body.length > 0 ? { body } : {}),
  })
}

try {
  await parity({
    provider: "aws-speech",
    spec: document,
    env: process.env,
    includeUnsafe: process.argv.includes("--include-unsafe"),
    real: {
      baseUrl: polly,
      allowedHosts: [new URL(polly).host, new URL(transcribe).host],
      fetch: signedFetch,
      minIntervalMs: 250,
    },
    mock: { create: () => new SpeechAPI() },
    redact: createRedactor([...credentials.secrets]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
