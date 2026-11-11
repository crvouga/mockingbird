import { createRuntime } from "@crvouga/mockingbird-service-slack"
import type { OutboundChat } from "../../app/ports/notifier.js"
import type { MockAdmin } from "../admin.js"

const BOT_TOKEN = "xoxb-cove-demo"
const BASE_URL = "https://slack.com"

/** The staff workspace: the three channels the app posts to. */
const CHANNELS = [
  { name: "lab-orders", purpose: "Every paid order as it enters fulfilment" },
  { name: "clinical-review", purpose: "Reports waiting for a clinician" },
  { name: "billing-alerts", purpose: "Declined and failed payments" },
]

/**
 * Posts staff alerts through Mockingbird's in-process Slack emulator with the
 * Web API call a bot makes: `POST /api/chat.postMessage`, JSON, Bearer bot
 * token. Slack answers 200 even when it refuses a message, so `ok` in the
 * body is what counts.
 */
export const createSlackMockChat = () => {
  const runtime = createRuntime({
    fixtures: { team: { name: "Cove", domain: "cove" }, channels: CHANNELS },
    settings: { teamName: "Cove", teamDomain: "cove" },
  })

  const sendChat = async (message: OutboundChat): Promise<void> => {
    const response = await runtime.fetch(
      new Request(`${BASE_URL}/api/chat.postMessage`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${BOT_TOKEN}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          channel: message.channel,
          text: message.text,
          ...(message.blocks ? { blocks: message.blocks } : {}),
        }),
      }),
    )
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string }
    if (!response.ok || !body.ok)
      throw new Error(`Slack rejected the message (${body.error ?? response.status})`)
  }

  const admin: MockAdmin = { id: "slack", label: "Slack", fetch: (r) => runtime.fetch(r) }
  return { sendChat, runtime, admin }
}
