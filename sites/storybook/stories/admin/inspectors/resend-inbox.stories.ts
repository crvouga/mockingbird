import { createRuntime } from "@crvouga/mockingbird-service-resend"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect } from "storybook/test"
import { hands } from "../../../src/interact.js"
import { page } from "../../../src/story.js"
import { call, inspector, phone, SHARED_SOURCES } from "./inspector.js"

/**
 * The Resend emulator's inbox (`/inbox`): every email the app sent, newest first, and each one
 * opened (`/inbox/:id`) with its recipients, tags and a sandboxed preview. The stories send
 * through `POST /emails`.
 */
export default {
  title: "Admin/Inspectors/Resend inbox",
  parameters: {
    layout: "fullscreen",
    sources: [...SHARED_SOURCES, "packages/http/provider/src/vendor/resend/routes/inbox.ts"],
  },
} satisfies Meta

const ORIGIN = "https://api.resend.com"

type Email = Record<string, unknown> & { subject: string }

async function send(emails: Email[]) {
  const resend = createRuntime()
  const ids: string[] = []
  for (const email of emails) {
    const body = await call(resend, `${ORIGIN}/emails`, {
      method: "POST",
      headers: { authorization: "Bearer re_storybook", "content-type": "application/json" },
      body: JSON.stringify({
        from: "Gamezilla <hello@gamezilla.dev>",
        to: ["alice@gmail.com"],
        ...email,
      }),
    })
    ids.push((JSON.parse(body) as { id: string }).id)
  }
  return { resend, ids }
}

const WELCOME: Email = {
  subject: "Welcome to Gamezilla",
  html: '<h1 style="font-family:system-ui">Welcome, Alice!</h1><p style="font-family:system-ui">Your servers are ready. <a href="https://gamezilla.dev">Open the dashboard</a>.</p>',
  tags: [{ name: "category", value: "onboarding" }],
}
const RECEIPT: Email = {
  subject: "Your receipt from Gamezilla",
  to: ["alice@gmail.com"],
  cc: ["billing@gamezilla.dev"],
  bcc: ["audit@gamezilla.dev"],
  text: "Unlimited plan — $7.00\nPaid with Visa •••• 4242\n\nThanks for playing!",
}
const MAIL = [
  WELCOME,
  RECEIPT,
  { subject: "Your plan renews in 3 days", to: ["bob@example.com"], text: "Heads up!" },
]

export const Inbox: StoryObj = inspector(
  async () => (await send(MAIL)).resend,
  `${ORIGIN}/inbox`,
  "Your plan renews in 3 days",
)

/** Nothing sent yet. */
export const Empty: StoryObj = inspector(createRuntime, `${ORIGIN}/inbox`, "No emails sent yet.")

/** An HTML email opened: tags and a sandboxed preview. */
export const HtmlEmail: StoryObj = {
  ...page(async () => {
    const { resend, ids } = await send([WELCOME])
    return { emulator: resend, url: `${ORIGIN}/inbox/${ids[0]}` }
  }),
  play: async ({ canvasElement }) => {
    const { doc } = await hands(canvasElement)
    await expect(doc.body.textContent).toContain("category: onboarding")
  },
}

/** A plain-text email with Cc and Bcc. */
export const TextEmail: StoryObj = {
  ...page(async () => {
    const { resend, ids } = await send([RECEIPT])
    return { emulator: resend, url: `${ORIGIN}/inbox/${ids[0]}` }
  }),
  play: async ({ canvasElement }) => {
    const { doc } = await hands(canvasElement)
    await expect(doc.body.textContent).toContain("audit@gamezilla.dev")
  },
}

/** An id the inbox does not know. */
export const NotFound: StoryObj = inspector(
  createRuntime,
  `${ORIGIN}/inbox/00000000-0000-0000-0000-000000000000`,
  "Email not found",
)

/** An email clicked in the inbox opens it. */
export const OpeningAnEmail: StoryObj = {
  ...Inbox,
  play: async ({ canvasElement }) => {
    const inbox = await hands(canvasElement)
    const link = [...inbox.doc.querySelectorAll<HTMLAnchorElement>("a.app-link")].find((a) =>
      a.textContent?.includes("Your receipt"),
    )
    if (!link) throw new Error("The receipt is not in the inbox")
    link.click()
    const opened = await inbox.navigated()
    await expect(opened.doc.body.textContent).toContain("billing@gamezilla.dev")
  },
}

export const OnAPhone: StoryObj = { ...Inbox, globals: phone }
