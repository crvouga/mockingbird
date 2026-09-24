/**
 * Live parity: the same random walk against a real Slack workspace and a fresh mock,
 * canonicalized and diffed. Credentials come from the environment
 * (`.env.local` locally, repo secrets in the Parity workflow):
 *
 *   MOCKINGBIRD_SLACK_BOT_TOKEN     a bot token (xoxb-…) in a sandbox workspace
 *
 * By default only safe operations run (auth.test, users.*, files.info, reactions.get,
 * chat.getPermalink). Posting, reacting, joining and opening views change a real workspace,
 * so they need `--include-unsafe` (point the token at a throwaway workspace first). Incoming
 * webhooks are never walked live: a webhook URL posts to a real channel.
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, SlackAPI, supportedOperationIds } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "slack",
      fields: { MOCKINGBIRD_SLACK_BOT_TOKEN: "MOCKINGBIRD_SLACK_BOT_TOKEN" },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`slack parity: no sandbox credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const token = credentials.values.MOCKINGBIRD_SLACK_BOT_TOKEN
const baseUrl = "https://slack.com"
try {
  await parity({
    provider: "slack",
    spec: document,
    env: process.env,
    includeUnsafe: process.argv.includes("--include-unsafe"),
    only: supportedOperationIds.filter((id) => id !== "PostIncomingWebhook"),
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: () => ({ authorization: `Bearer ${token}` }),
      // Slack's Tier 3/4 limits: stay well under 50 calls a minute.
      minIntervalMs: 1_500,
    },
    mock: {
      create: () => new SlackAPI(),
      headers: () => ({ authorization: "Bearer xoxb-parity-token" }),
    },
    redact: createRedactor([...credentials.secrets, token]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
