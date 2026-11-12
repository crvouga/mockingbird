import { createRuntime } from "@crvouga/mockingbird-service-slack"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { call, inspector, openTab, phone, SHARED_SOURCES } from "./inspector.js"

/**
 * The Slack emulator's message inspector (`/`): a conversation's messages, threads, pins and
 * bookmarks; channels; files; App Home and modal views; OAuth and incoming webhooks; event
 * deliveries. The stories post through the Web API with a bot token.
 */
export default {
  title: "Admin/Inspectors/Slack",
  parameters: {
    layout: "fullscreen",
    sources: [...SHARED_SOURCES, "packages/http/provider/src/vendor/slack/routes/inspector.ts"],
  },
} satisfies Meta

const ORIGIN = "https://slack.com"

/** A deploy announced in #general with a thread and a reaction, an #incidents channel, an App Home. */
async function workspace() {
  const slack = createRuntime()
  const api = async (method: string, body: unknown) =>
    JSON.parse(
      await call(slack, `${ORIGIN}/api/${method}`, {
        method: "POST",
        headers: {
          authorization: "Bearer xoxb-storybook",
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      }),
    ) as { ts?: string }
  const deploy = await api("chat.postMessage", {
    channel: "C0GENERAL",
    text: "Deploy finished",
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Deploy finished* — v2.4.0 is live :rocket:" },
      },
    ],
  })
  await api("chat.postMessage", {
    channel: "C0GENERAL",
    text: "Checkout looks good from here",
    thread_ts: deploy.ts,
  })
  await api("reactions.add", { channel: "C0GENERAL", timestamp: deploy.ts, name: "tada" })
  await api("chat.postMessage", { channel: "C0GENERAL", text: "Reminder: retro at 3pm" })
  await api("conversations.create", { name: "incidents" })
  await api("views.publish", {
    user_id: "U0MOCKBOT",
    view: {
      type: "home",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "Welcome to *Gamezilla Ops*" } }],
    },
  })
  return slack
}

/** #general: the deploy announcement, its thread and reaction. */
export const Messages: StoryObj = inspector(
  workspace,
  `${ORIGIN}/?tab=messages&channel=C0GENERAL`,
  "Reminder: retro at 3pm",
)

/** The first conversation, which has no messages yet. */
export const EmptyConversation: StoryObj = inspector(
  createRuntime,
  `${ORIGIN}/?tab=messages`,
  "No messages yet.",
)

export const Channels: StoryObj = inspector(workspace, `${ORIGIN}/?tab=channels`, "incidents")

export const Files: StoryObj = inspector(workspace, `${ORIGIN}/?tab=files`, "lab-report.pdf")

/** App Home views published, no modals open. */
export const Views: StoryObj = inspector(workspace, `${ORIGIN}/?tab=views`, "Gamezilla Ops")

export const Auth: StoryObj = inspector(workspace, `${ORIGIN}/?tab=auth`, "Default Webhook")

export const Events: StoryObj = inspector(
  workspace,
  `${ORIGIN}/?tab=events`,
  "No Slack event deliveries yet.",
)

/** Following the Channels tab from Messages. */
export const SwitchingTabs: StoryObj = {
  ...Messages,
  play: async ({ canvasElement }) => openTab(canvasElement, "Channels", "incidents"),
}

export const OnAPhone: StoryObj = { ...Messages, globals: phone }
