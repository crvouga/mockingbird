/**
 * Live parity: the same random walk against a real portal-agent deployment and a fresh mock,
 * canonicalized and diffed. The portal agent is our own service (the LifeFile / VPI browser
 * runner), not a third-party sandbox. Credentials come from the environment
 * (`.env.local` locally, repo secrets in the Parity workflow):
 *
 *   MOCKINGBIRD_PORTAL_AGENT_API_URL    the agent's base URL
 *   MOCKINGBIRD_PORTAL_AGENT_API_KEY    its bearer key (ERX_PORTAL_AGENT_API_KEY)
 *
 * Creating a job drives a real pharmacy portal, so the only operation is unsafe: it runs only
 * with `--include-unsafe`, and should only ever target an agent whose `allowSubmit` is off.
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, PortalAgentAPI } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "portal-agent",
      fields: {
        MOCKINGBIRD_PORTAL_AGENT_API_URL: "MOCKINGBIRD_PORTAL_AGENT_API_URL",
        MOCKINGBIRD_PORTAL_AGENT_API_KEY: "MOCKINGBIRD_PORTAL_AGENT_API_KEY",
      },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(
      `portal-agent parity: no live deployment configured (the portal agent is our own service). ${error.message}`,
    )
    process.exit(2)
  }
  throw error
}

const baseUrl = credentials.values.MOCKINGBIRD_PORTAL_AGENT_API_URL.replace(/\/$/, "")
const apiKey = credentials.values.MOCKINGBIRD_PORTAL_AGENT_API_KEY

try {
  await parity({
    provider: "portal-agent",
    spec: document,
    env: process.env,
    includeUnsafe: process.argv.includes("--include-unsafe"),
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: () => ({ authorization: `Bearer ${apiKey}`, accept: "application/json" }),
      minIntervalMs: 250,
    },
    mock: {
      create: () => new PortalAgentAPI(),
      headers: () => ({ authorization: "Bearer parity", accept: "application/json" }),
    },
    redact: createRedactor([...credentials.secrets]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
