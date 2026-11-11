/**
 * End-to-end: real Twilio, Resend and FCM emulators, the harness server, and the UI in Chromium,
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

let emulators: { twilio: Emulator; resend: Emulator; fcm: Emulator }
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
  const [t, r, f] = await Promise.all([twilio(), resend(), fcm()])
  emulators = { twilio: t, resend: r, fcm: f }
  server = await createServer({
    services: { twilio: t.url, resend: r.url, fcm: f.url },
    pollIntervalMs: 200,
  })
  client = new NotificationClient(server.url)
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 1720, height: 1040 } })

  await send.fcmRegister(target(f), IOS_TOKEN, "ios")
  await send.twilioSms(target(t), { to: PHONE, from: SENDER, body: "Acme: order #1042 shipped." })
  await send.twilioVerify(target(t), PHONE)
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
    expect(await app.getAttribute("data-count")).toBe("4")
    expect(await app.getAttribute("data-view")).toBe("devices")
    await expect(byId(TEST_IDS.source).count()).resolves.toBe(3)
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
    await expect(page.locator(selectors.timelineRow()).count()).resolves.toBe(4)
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
