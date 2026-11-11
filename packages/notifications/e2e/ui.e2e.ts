/**
 * End-to-end: real Twilio, Resend, FCM and Slack emulators, the harness server, and the UI in Chromium,
 * found only through the selectors in `src/testids.ts`. It doubles as the worked example the
 * README points to.
 *
 *   bun run e2e        # needs Chromium: bunx playwright install chromium
 *
 * It is not part of `bun test`, which runs without a browser.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer as fcm } from "@crvouga/mockingbird-service-fcm/server"
import { createServer as resend } from "@crvouga/mockingbird-service-resend/server"
import { createServer as slack } from "@crvouga/mockingbird-service-slack/server"
import { createServer as twilio } from "@crvouga/mockingbird-service-twilio/server"
import { type Browser, chromium, type Page } from "@playwright/test"
import { NotificationClient, selectors, TEST_IDS } from "../src/index.js"
import { createServer, type NotificationServer } from "../src/server.js"
import * as send from "../test/send.js"

type Emulator = { url: string; close(): Promise<void> }
const PHONE = "+12025550123"
const SENDER = "+18885550100"
const INBOX = "ada@example.com"
const IOS_TOKEN = "ios-e2e-token"
const WHATSAPP_SENDER = "whatsapp:+14155238886"
const CHAT_CHANNEL = "#alerts"
const WIDE = { width: 1720, height: 1040 }

let emulators: { twilio: Emulator; resend: Emulator; fcm: Emulator; slack: Emulator }
let server: NotificationServer
let client: NotificationClient
let browser: Browser
let page: Page

const target = (e: Emulator): send.Target => ({
  url: e.url.replace(/\/$/, ""),
  fetch: (request) => fetch(request),
})
const byId = (id: (typeof TEST_IDS)[keyof typeof TEST_IDS]) => page.getByTestId(id)

beforeAll(async () => {
  const [t, r, f, s] = await Promise.all([twilio(), resend(), fcm(), slack()])
  emulators = { twilio: t, resend: r, fcm: f, slack: s }
  server = await createServer({
    services: { twilio: t.url, resend: r.url, fcm: f.url, slack: s.url },
    pollIntervalMs: 200,
  })
  client = new NotificationClient(server.url)
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: WIDE })

  await send.fcmRegister(target(f), IOS_TOKEN, "ios")
  await send.twilioSms(target(t), { to: PHONE, from: SENDER, body: "Acme: order #1042 shipped." })
  await send.twilioWhatsApp(target(t), {
    to: PHONE,
    body: "Acme: your parcel is out for delivery.",
  })
  await send.twilioVerify(target(t), PHONE)
  await send.slackPost(target(s), {
    channel: CHAT_CHANNEL,
    text: "Order #1042 shipped",
    blocks: [{ type: "section", text: { type: "mrkdwn", text: "Order *#1042* shipped" } }],
  })
  await send.resendEmail(target(r), {
    from: "Acme <orders@acme.example>",
    to: [INBOX],
    subject: "Your order shipped",
    html: "<h1>On its way</h1><p>Order <b>#1042</b> left the warehouse.</p>",
  })
  await send.fcmPush(target(f), {
    token: IOS_TOKEN,
    notification: { title: "Order shipped", body: "Arriving Thursday." },
    data: { orderId: "1042" },
  })
  // Everything is in the harness before the page opens.
  await client.waitFor({ channel: "push", to: IOS_TOKEN })
}, 30_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  await Promise.all(Object.values(emulators ?? {}).map((e) => e.close()))
})

describe("harness UI through its test ids", () => {
  test("the root reports when it is ready and what it holds", async () => {
    await page.goto(server.url)
    await page.locator(selectors.ready()).waitFor()
    const app = byId(TEST_IDS.app)
    expect(await app.getAttribute("data-count")).toBe("6")
    expect(await app.getAttribute("data-view")).toBe("devices")
    await expect(byId(TEST_IDS.source).count()).resolves.toBe(4)
  })

  test("SMS: a deep link opens the conversation; bubbles carry the message fields", async () => {
    await page.goto(client.link({ channel: "sms", to: PHONE }))
    await page.locator(selectors.ready()).waitFor()
    const device = byId(TEST_IDS.smsDevice)
    expect(await device.getAttribute("data-recipient")).toBe(PHONE)

    // Back to the list, then into the order conversation by its sender.
    if ((await device.getAttribute("data-screen")) === "conversation")
      await byId(TEST_IDS.smsBack).click()
    await page.locator(selectors.smsThread(SENDER)).click()
    const bubble = page.locator(selectors.smsBubble({ from: SENDER }))
    await expect(bubble.textContent()).resolves.toContain("order #1042 shipped")
    expect(await bubble.getAttribute("data-service")).toBe("twilio")
    expect(await bubble.getAttribute("data-to")).toBe(PHONE)
  })

  test("SMS: a one-time code is exposed as data-code", async () => {
    const code = await client.waitForCode(PHONE)
    const [verify] = await client.list({ channel: "sms", to: PHONE, contains: code })
    if (!verify) throw new Error("no verification text")
    // `?id=` opens that message's conversation directly.
    await page.goto(client.link({ id: verify.id }))
    await page.locator(selectors.ready()).waitFor()
    const bubble = page.locator(selectors.smsBubble({ id: verify.id }))
    expect(await bubble.getAttribute("data-code")).toBe(code)
    expect(await byId(TEST_IDS.smsCode).getAttribute("data-code")).toBe(code)
  })

  test("WhatsApp: a whatsapp: message is its own thread, drawn as WhatsApp", async () => {
    await page.goto(client.link({ channel: "sms", to: PHONE }))
    await page.locator(selectors.ready()).waitFor()
    if ((await byId(TEST_IDS.smsDevice).getAttribute("data-screen")) === "conversation")
      await byId(TEST_IDS.smsBack).click()
    const thread = page.locator(selectors.smsThread(WHATSAPP_SENDER))
    expect(await thread.getAttribute("data-via")).toBe("whatsapp")
    await expect(thread.getByTestId(TEST_IDS.smsThreadVia).textContent()).resolves.toBe("WhatsApp")
    await thread.click()
    expect(await byId(TEST_IDS.smsDevice).getAttribute("data-via")).toBe("whatsapp")
    expect(await byId(TEST_IDS.smsConversation).getAttribute("data-via")).toBe("whatsapp")
    // The recipient is the bare number; the `whatsapp:` prefix never reaches the screen.
    await expect(byId(TEST_IDS.smsConversationTitle).textContent()).resolves.not.toContain(
      "whatsapp:",
    )
    await expect(
      page.locator(selectors.smsBubble({ from: WHATSAPP_SENDER })).textContent(),
    ).resolves.toContain("out for delivery")
  })

  test("chat: a Slack message shows in its channel with author, time and blocks", async () => {
    await page.goto(client.link({ channel: "chat", to: CHAT_CHANNEL }))
    await page.locator(selectors.ready()).waitFor()
    expect(await byId(TEST_IDS.chatDevice).getAttribute("data-recipient")).toBe(CHAT_CHANNEL)
    await expect(byId(TEST_IDS.chatTitle).textContent()).resolves.toBe(CHAT_CHANNEL)
    const [posted] = await client.list({ channel: "chat", to: CHAT_CHANNEL })
    const message = page.locator(selectors.chatMessage(posted?.id))
    expect(await message.getAttribute("data-service")).toBe("slack")
    expect(await message.getAttribute("data-method")).toBe("chat.postMessage")
    await expect(message.getByTestId(TEST_IDS.chatMessageAuthor).textContent()).resolves.toBe(
      "Mockingbird Bot",
    )
    await expect(message.getByTestId(TEST_IDS.chatMessageBlocks).innerHTML()).resolves.toContain(
      "<b>#1042</b>",
    )
    expect(
      await page.locator(selectors.chatChannel(CHAT_CHANNEL)).getAttribute("aria-current"),
    ).toBe("true")
  })

  test("push: the iOS lock screen shows the card; expanding shows its data", async () => {
    const [push] = await client.list({ channel: "push", to: IOS_TOKEN })
    if (!push) throw new Error("no push")
    await page.goto(client.link({ channel: "push", to: IOS_TOKEN }))
    await page.locator(selectors.ready()).waitFor()
    expect(await byId(TEST_IDS.pushDevice).getAttribute("data-skin")).toBe("ios")
    const card = page.locator(selectors.pushNotification(push.id))
    await expect(card.getByTestId(TEST_IDS.pushNotificationTitle).textContent()).resolves.toBe(
      "Order shipped",
    )
    await card.click()
    expect(await card.getAttribute("data-expanded")).toBe("true")
    await expect(card.getByTestId(TEST_IDS.pushNotificationData).textContent()).resolves.toContain(
      "1042",
    )
  })

  test("email: open a row and read the HTML body inside its iframe", async () => {
    await page.goto(client.link({ channel: "email", to: INBOX }))
    await page.locator(selectors.ready()).waitFor()
    const row = byId(TEST_IDS.emailRow).first()
    await expect(row.getByTestId(TEST_IDS.emailRowSubject).textContent()).resolves.toBe(
      "Your order shipped",
    )
    await row.click()
    await expect(byId(TEST_IDS.emailSubject).textContent()).resolves.toBe("Your order shipped")
    const body = page.frameLocator(selectors.testId(TEST_IDS.emailBody))
    await expect(body.locator("h1").textContent()).resolves.toBe("On its way")
  })

  test("timeline and inspector: every record, with its raw emulator JSON", async () => {
    await page.goto(`${server.url}?view=timeline`)
    await page.locator(selectors.ready()).waitFor()
    await expect(page.locator(selectors.timelineRow()).count()).resolves.toBe(6)
    await page.locator(selectors.timelineRow()).first().click()
    await byId(TEST_IDS.inspector).waitFor()
    const json = JSON.parse((await byId(TEST_IDS.inspectorJson).textContent()) ?? "{}")
    expect(json.raw).toBeDefined()
    await byId(TEST_IDS.inspectorClose).click()
    expect(await byId(TEST_IDS.inspector).isHidden()).toBe(true)
  })

  test("a message sent while the page is open appears live", async () => {
    await page.goto(client.link({ channel: "email", to: INBOX }))
    await page.locator(selectors.ready()).waitFor()
    await send.resendEmail(target(emulators.resend), {
      from: "Acme <orders@acme.example>",
      to: [INBOX],
      subject: "Delivered",
      text: "Your parcel was delivered.",
    })
    const [delivered] = await client.waitFor({ channel: "email", contains: "Delivered" })
    await page.locator(selectors.emailRow(delivered?.id)).waitFor()
    expect(await page.locator(selectors.emailRow(delivered?.id)).getAttribute("data-unread")).toBe(
      "true",
    )
  })
})

describe("dashboard: emulators and notifications on one page", () => {
  const tab = (id: string) => page.locator(selectors.dashboardTab(id))
  const panel = (id: string) => page.locator(selectors.dashboardPanel(id))

  test("the Emulators tab is the emulators' real admin UI", async () => {
    await page.goto(`${server.url}?tab=emulators`)
    await byId(TEST_IDS.dashboard).waitFor()
    expect(await tab("emulators").getAttribute("aria-selected")).toBe("true")
    // The shared admin UI, mounted in a shadow root and reading Twilio through the harness.
    const admin = panel("emulators").locator("#admin-root")
    await admin.getByText("Overview").first().waitFor()
    await admin.getByText("twilio").first().waitFor()
    expect(await panel("notifications").isHidden()).toBe(true)
    const health = await page.request.get(`${server.url}/admin/apis/twilio/health`)
    expect(((await health.json()) as { service: string }).service).toBe("twilio")
  })

  test("the Notifications tab counts what arrives while Emulators is open", async () => {
    const badge = byId(TEST_IDS.dashboardBadge)
    expect(await badge.isHidden()).toBe(true)
    await send.twilioSms(target(emulators.twilio), {
      to: PHONE,
      from: SENDER,
      body: "Acme: your refund was issued.",
    })
    await page.locator(`${selectors.dashboardTab("notifications")} [data-count="1"]`).waitFor()
    expect(await badge.isVisible()).toBe(true)

    await tab("notifications").click()
    expect(await tab("notifications").getAttribute("aria-selected")).toBe("true")
    expect(new URL(page.url()).searchParams.get("tab")).toBe("notifications")
    expect(await badge.isHidden()).toBe(true)
    // The devices were live all along: the new text is already there.
    await page.locator(selectors.ready()).waitFor()
    expect(await byId(TEST_IDS.smsDevice).isVisible()).toBe(true)
    expect(await panel("emulators").isHidden()).toBe(true)

    // Arrow keys move between tabs; the admin UI kept its state.
    await tab("notifications").press("ArrowLeft")
    expect(await tab("emulators").getAttribute("aria-selected")).toBe("true")
    expect(await panel("emulators").locator("#admin-root").getByText("Overview").count()).not.toBe(
      0,
    )
  })
})

/** Where each visible device frame starts, and the row (its column's top) it sits on. */
const frames = (p: Page) =>
  p.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-region^="col-"]')]
      .filter((col) => !col.hidden)
      .map((col) => {
        const frame = col.querySelector<HTMLElement>(
          '[data-testid="sms-device"], [data-testid="push-device"], [data-testid="email-device"], [data-testid="chat-device"]',
        )
        return {
          region: col.dataset.region ?? "",
          row: col.getBoundingClientRect().top,
          top: frame?.getBoundingClientRect().top ?? Number.NaN,
        }
      }),
  )

describe("layout: aligned devices and channel tabs", () => {
  test("wide: all four device frames start at exactly the same height", async () => {
    await page.setViewportSize(WIDE)
    await page.goto(server.url)
    await page.locator(selectors.ready()).waitFor()
    const found = await frames(page)
    expect(found.map((f) => f.region)).toEqual(["col-sms", "col-push", "col-email", "col-chat"])
    expect(new Set(found.map((f) => f.row)).size).toBe(1)
    expect(new Set(found.map((f) => f.top)).size).toBe(1)
  })

  test("when the row wraps, frames that share a row still line up", async () => {
    for (const width of [1440, 1180, 900]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(server.url)
      await page.locator(selectors.ready()).waitFor()
      const found = await frames(page)
      expect(found).toHaveLength(4)
      // Every frame sits the same distance below its own row, whatever controls its head has.
      expect(new Set(found.map((f) => f.top - f.row)).size).toBe(1)
    }
    await page.setViewportSize(WIDE)
  })

  test("wide: the tabs pick one device, follow the arrow keys and sync the URL", async () => {
    await page.goto(server.url)
    await page.locator(selectors.ready()).waitFor()
    expect(await byId(TEST_IDS.app).getAttribute("data-layout")).toBe("grid")
    expect(await byId(TEST_IDS.channelTabs).getAttribute("role")).toBe("tablist")
    const values = await byId(TEST_IDS.channelTab).evaluateAll((tabs) =>
      tabs.map((t) => `${t.getAttribute("data-value")}:${t.getAttribute("aria-selected")}`),
    )
    expect(values).toEqual(["all:true", "sms:false", "push:false", "email:false", "chat:false"])

    await page.locator(selectors.channelTab("chat")).click()
    expect(await page.locator(selectors.channelTab("chat")).getAttribute("aria-selected")).toBe(
      "true",
    )
    expect(await byId(TEST_IDS.app).getAttribute("data-tab")).toBe("chat")
    expect((await frames(page)).map((f) => f.region)).toEqual(["col-chat"])
    expect(new URL(page.url()).searchParams.get("view")).toBe("chat")

    await page.keyboard.press("ArrowLeft")
    expect(await page.locator(selectors.channelTab("email")).getAttribute("aria-selected")).toBe(
      "true",
    )
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-value"))).toBe(
      "email",
    )
    expect((await frames(page)).map((f) => f.region)).toEqual(["col-email"])
    await page.keyboard.press("Home")
    expect((await frames(page)).map((f) => f.region)).toHaveLength(4)
    expect(new URL(page.url()).searchParams.get("view")).toBeNull()
  })

  test("a tab counts what arrives on a device that is not on screen", async () => {
    await page.goto(client.link({ channel: "email" }))
    await page.locator(selectors.ready()).waitFor()
    const chatTab = page.locator(selectors.channelTab("chat"))
    const before = Number(await chatTab.getAttribute("data-unread"))
    await send.slackPost(target(emulators.slack), { channel: CHAT_CHANNEL, text: "Refund issued" })
    await client.waitFor({ channel: "chat", contains: "Refund issued" })
    await page
      .locator(`${selectors.channelTab("chat")}[data-unread="${before + 1}"]`)
      .waitFor({ timeout: 5_000 })
    await expect(chatTab.getByTestId(TEST_IDS.channelTabUnread).textContent()).resolves.toBe(
      String(before + 1),
    )
    // Opening the tab and its channel reads them.
    await chatTab.click()
    await page.locator(selectors.chatChannel(CHAT_CHANNEL)).click()
    expect(await chatTab.getAttribute("data-unread")).toBe("0")
    expect(await chatTab.getByTestId(TEST_IDS.channelTabUnread).count()).toBe(0)
  })

  test("narrow: one device at a time behind the tabs, with no All tab", async () => {
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } })
    try {
      await phone.goto(server.url)
      await phone.locator(selectors.ready()).waitFor()
      const app = phone.getByTestId(TEST_IDS.app)
      expect(await app.getAttribute("data-layout")).toBe("tabs")
      const values = await phone
        .getByTestId(TEST_IDS.channelTab)
        .evaluateAll((tabs) => tabs.map((t) => t.getAttribute("data-value")))
      expect(values).toEqual(["sms", "push", "email", "chat"])
      expect((await frames(phone)).map((f) => f.region)).toEqual(["col-sms"])

      const tops: number[] = []
      for (const channel of ["sms", "push", "email", "chat"] as const) {
        await phone.locator(selectors.channelTab(channel)).click()
        expect(await app.getAttribute("data-tab")).toBe(channel)
        const found = await frames(phone)
        expect(found.map((f) => f.region)).toEqual([`col-${channel}`])
        tops.push(found[0]?.top ?? Number.NaN)
        // Nothing spills past the screen edge.
        expect(
          await phone.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(390)
      }
      // Switching tabs never moves the frame.
      expect(new Set(tops).size).toBe(1)

      // Widening the same page brings every device back, side by side.
      await phone.setViewportSize(WIDE)
      await phone.locator(`${selectors.testId(TEST_IDS.app)}[data-layout="grid"]`).waitFor()
      await phone.locator(selectors.channelTab("all")).click()
      expect(await frames(phone)).toHaveLength(4)
    } finally {
      await phone.close()
    }
  })
})
