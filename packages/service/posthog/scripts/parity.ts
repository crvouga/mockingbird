/**
 * Live parity: the same random walk against a real PostHog project and a fresh mock,
 * canonicalized and diffed. Credentials come from the environment
 * (`.env.local` locally, repo secrets in the Parity workflow):
 *
 *   POSTHOG_HOST            e.g. https://us.i.posthog.com
 *   POSTHOG_PROJECT_TOKEN   a phc_… token of a sandbox project with NO feature flags
 *
 * Every request's project token (body `token` / `api_key`, `?token=`, `/array/{token}/…`) is
 * rewritten to the sandbox token on the real side, since the walk generates random ones. Only
 * the public, read-only surface runs by default (flags, decide, remote config, surveys, web
 * experiments, recorder): capture writes events into the project and the management API needs
 * a personal key, so `--include-unsafe` adds capture only.
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, PostHogAPI } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "posthog",
      fields: {
        POSTHOG_HOST: "POSTHOG_HOST",
        POSTHOG_PROJECT_TOKEN: "POSTHOG_PROJECT_TOKEN",
      },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`posthog parity: no sandbox credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const baseUrl = credentials.values.POSTHOG_HOST.replace(/\/$/, "")
const realToken = credentials.values.POSTHOG_PROJECT_TOKEN
const MOCK_TOKEN = "phc_mockingbird_parity"

/** Put `token` everywhere a PostHog request carries a project key. */
const withToken =
  (token: string, send: (request: Request) => Promise<Response>) =>
  async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    url.pathname = url.pathname.replace(/^\/array\/[^/]+\//, `/array/${token}/`)
    if (url.searchParams.has("token")) url.searchParams.set("token", token)
    let body: string | undefined
    if (request.method !== "GET" && request.method !== "HEAD") {
      const text = await request.text()
      try {
        const value = JSON.parse(text) as Record<string, unknown>
        if (value && typeof value === "object" && !Array.isArray(value)) {
          if ("token" in value || !("api_key" in value)) value.token = token
          if ("api_key" in value) value.api_key = token
        }
        body = JSON.stringify(value)
      } catch {
        body = text
      }
    }
    return send(
      new Request(url, {
        method: request.method,
        headers: request.headers,
        ...(body !== undefined ? { body } : {}),
      }),
    )
  }

const safe = [
  "EvaluateFlags",
  "Decide",
  "GetRemoteConfig",
  "GetRemoteConfigScript",
  "GetRecorderScript",
  "GetVersionedRecorderScript",
  "ListSurveys",
  "ListWebExperiments",
]
const includeUnsafe = process.argv.includes("--include-unsafe")

try {
  await parity({
    provider: "posthog",
    spec: document,
    env: process.env,
    includeUnsafe,
    only: includeUnsafe ? [...safe, "CaptureBatch", "CaptureEvent", "CaptureEventV0"] : safe,
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      fetch: withToken(realToken, (request) => fetch(request)),
      minIntervalMs: 250,
    },
    mock: {
      create: () => {
        const api = new PostHogAPI()
        return { fetch: withToken(MOCK_TOKEN, (request) => api.fetch(request)) }
      },
    },
    redact: createRedactor([...credentials.secrets, realToken]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
