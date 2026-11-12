import { createRuntime } from "@crvouga/mockingbird-service-twilio"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { call, inspector, openTab, phone, SHARED_SOURCES } from "./inspector.js"

/**
 * The Twilio emulator's inspector (`/`): messages, Verify, calls, conversations, numbers,
 * messaging services, credentials and webhook deliveries. The stories send texts, start a
 * verification and place a call through Twilio's REST API.
 */
export default {
  title: "Admin/Inspectors/Twilio",
  parameters: {
    layout: "fullscreen",
    sources: [...SHARED_SOURCES, "packages/http/provider/src/vendor/twilio/routes/inspector.ts"],
  },
} satisfies Meta

const ORIGIN = "https://api.twilio.com"
const ACCOUNT = "AC00000000000000000000000000000000"
const FROM = "+15551234567"
const form = (params: Record<string, string>) => ({
  method: "POST",
  headers: {
    authorization: `Basic ${btoa(`${ACCOUNT}:twilio_test_auth_token`)}`,
    "content-type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams(params).toString(),
})

/** Two texts sent, a verification pending and a call placed. */
async function busy() {
  const twilio = createRuntime()
  for (const [to, body] of [
    ["+14155550101", "Your Gamezilla code is 482913"],
    ["+14155550102", "Your order has shipped. Track it at https://gamezilla.dev/t/1042"],
  ] as const)
    await call(
      twilio,
      `${ORIGIN}/2010-04-01/Accounts/${ACCOUNT}/Messages.json`,
      form({ To: to, From: FROM, Body: body }),
    )
  await call(
    twilio,
    "https://verify.twilio.com/v2/Services/VA00000000000000000000000000000000/Verifications",
    form({ To: "+14155550101", Channel: "sms" }),
  )
  await call(
    twilio,
    `${ORIGIN}/2010-04-01/Accounts/${ACCOUNT}/Calls.json`,
    form({ To: "+14155550103", From: FROM, Url: "https://gamezilla.dev/twiml/welcome" }),
  )
  return twilio
}

const tab = (name: string, text: string, start: () => unknown = busy) =>
  inspector(start as typeof busy, `${ORIGIN}/?tab=${name}`, text)

export const Messages: StoryObj = tab("messages", "Your order has shipped")

/** Nothing sent yet. */
export const NoMessages: StoryObj = tab("messages", "No messages.", createRuntime)

/**
 * Verify services and verifications. The verification `busy()` starts is not listed: the Verify
 * API keeps it in the runtime's own `verifications` collection, and this tab reads the ported
 * store's `twilio.verifications`, which nothing writes any more.
 */
export const Verify: StoryObj = tab("verify", "Local Verify Service")

export const Calls: StoryObj = tab("calls", "+14155550103")

export const Conversations: StoryObj = tab("conversations", "Local Conversations")

export const Numbers: StoryObj = tab("numbers", FROM)

export const Services: StoryObj = tab("services", "Local Messaging Service")

/** Accounts and API keys, secrets masked. */
export const Auth: StoryObj = tab("auth", "Local Twilio Account")

export const Webhooks: StoryObj = tab("webhooks", "Webhook Deliveries")

/** Following the Verify tab from Messages. */
export const SwitchingTabs: StoryObj = {
  ...Messages,
  play: async ({ canvasElement }) => openTab(canvasElement, "Verify", "Local Verify Service"),
}

export const OnAPhone: StoryObj = { ...Messages, globals: phone }
