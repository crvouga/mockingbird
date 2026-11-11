import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer as customerio } from "@crvouga/mockingbird-service-customerio/server"
import { createServer as fcm } from "@crvouga/mockingbird-service-fcm/server"
import { createServer as mailosaur } from "@crvouga/mockingbird-service-mailosaur/server"
import { createServer as resend } from "@crvouga/mockingbird-service-resend/server"
import { createServer as ses } from "@crvouga/mockingbird-service-ses/server"
import { createServer as sns } from "@crvouga/mockingbird-service-sns/server"
import { createServer as twilio } from "@crvouga/mockingbird-service-twilio/server"
import { createNotificationHarness, type NotificationHarness, parseMime } from "./src/index.js"
import * as send from "./test/send.js"

type Server = { url: string; close(): Promise<void> }
const servers: Record<string, Server> = {}
const target = (name: string): send.Target => {
  const server = servers[name]
  if (!server) throw new Error(`no ${name}`)
  return { url: server.url.replace(/\/$/, ""), fetch: (request) => fetch(request) }
}
let harness: NotificationHarness

beforeAll(async () => {
  const started = await Promise.all([
    twilio(),
    resend(),
    fcm(),
    ses(),
    sns(),
    customerio(),
    mailosaur(),
  ])
  for (const [i, name] of [
    "twilio",
    "resend",
    "fcm",
    "ses",
    "sns",
    "customerio",
    "mailosaur",
  ].entries())
    servers[name] = started[i] as Server
  harness = createNotificationHarness({
    services: Object.fromEntries(Object.entries(servers).map(([name, s]) => [name, s.url])),
    pollIntervalMs: 0,
  })
})

afterAll(async () => {
  harness.close()
  await Promise.all(Object.values(servers).map((s) => s.close()))
})

describe("each emulator shows up as the recipient would see it", () => {
  test("Twilio SMS and Verify codes", async () => {
    await send.twilioSms(target("twilio"), {
      to: "+12025550123",
      body: "Your order shipped: https://shop.example/o/1",
    })
    await send.twilioVerify(target("twilio"), "+12025550123")
    const sms = await harness.list({ service: "twilio", to: "+12025550123" })
    expect(sms).toHaveLength(2)
    expect(sms[0]).toMatchObject({
      channel: "sms",
      source: "twilio",
      namespace: "default",
      from: { address: "+15005550006" },
      sms: { body: "Your order shipped: https://shop.example/o/1", code: null },
    })
    expect(sms[1]?.sms?.code).toMatch(/^\d{6}$/)
    expect(sms[1]?.from).toEqual({ name: "Verify", address: "Verify" })
  })

  test("Resend email lands in every recipient's mailbox", async () => {
    await send.resendEmail(target("resend"), {
      from: "Acme <no-reply@acme.example>",
      to: ["invitee@example.com"],
      cc: ["Boss <boss@example.com>"],
      subject: "You're invited",
      html: '<p>Join <a href="https://app.example/claim?token=abc">here</a></p>',
    })
    const [invitee] = await harness.list({ channel: "email", to: "invitee@example.com" })
    expect(invitee).toMatchObject({
      service: "resend",
      from: { name: "Acme", address: "no-reply@acme.example" },
      email: { subject: "You're invited", cc: ["boss@example.com"] },
      preview: "Join here",
    })
    expect(await harness.list({ channel: "email", to: "boss@example.com" })).toHaveLength(1)
  })

  test("FCM push keeps title, body, image, data and the device platform", async () => {
    await send.fcmRegister(target("fcm"), "ios-device-token", "ios")
    await send.fcmPush(target("fcm"), {
      token: "ios-device-token",
      notification: {
        title: "Order shipped",
        body: "Arriving Tuesday",
        image: "https://cdn.example/box.png",
      },
      data: { orderId: "1042" },
      apns: { payload: { aps: { badge: 3, sound: "default" } } },
    })
    const [push] = await harness.list({ channel: "push", to: "ios-device-token" })
    expect(push?.push).toEqual({
      title: "Order shipped",
      body: "Arriving Tuesday",
      imageUrl: "https://cdn.example/box.png",
      app: "demo-project",
      platform: "ios",
      data: { orderId: "1042" },
      badge: 3,
      sound: "default",
    })
    expect(push?.status).toBe("delivered")
  })

  test("SES SendEmail and SendRawEmail", async () => {
    await send.sesEmail(target("ses"))
    await send.sesRawEmail(target("ses"))
    const [receipt] = await harness.list({ service: "ses", to: "ada@example.com" })
    expect(receipt).toMatchObject({
      from: { name: "Shop Billing", address: "billing@shop.example" },
      email: {
        subject: "Your receipt #1042",
        cc: ["accounts@example.com"],
        text: "Thanks, Ada. Total: $42.00",
      },
    })
    expect(await harness.list({ service: "ses", to: "accounts@example.com" })).toHaveLength(1)
    const [raw] = await harness.list({ service: "ses", to: "grace@example.com" })
    expect(raw?.email).toMatchObject({
      subject: "Weekly report ✅",
      text: "Plain report",
      html: "<p>HTML ✅ report</p>",
      attachments: [{ filename: "report.csv", contentType: "text/csv", size: 8 }],
    })
  })

  test("SNS direct SMS and topic fan-out to SMS and email subscribers", async () => {
    await send.snsSms(target("sns"), "+12025550177", "Your SNS code is 4321")
    await send.snsTopicFanout(target("sns"))
    const [direct] = await harness.list({ service: "sns", to: "+12025550177" })
    expect(direct).toMatchObject({ channel: "sms", sms: { body: "Your SNS code is 4321" } })
    const [fanSms] = await harness.list({ service: "sns", to: "+12025550188" })
    expect(fanSms).toMatchObject({
      channel: "sms",
      from: { name: "order-alerts" },
      sms: { body: "Order 1042 has shipped." },
    })
    const [fanEmail] = await harness.list({ service: "sns", to: "ops@example.com" })
    expect(fanEmail).toMatchObject({
      channel: "email",
      from: { name: "AWS Notifications", address: "no-reply@sns.amazonaws.com" },
      email: { subject: "Order 1042 shipped" },
    })
    expect(fanEmail?.email?.text).toStartWith("Order 1042 has shipped.")
  })

  test("Customer.io transactional email and SMS", async () => {
    await send.customerioSend(target("customerio"), "email", {
      transactional_message_id: "welcome",
      identifiers: { email: "new@example.com" },
      to: "new@example.com",
      from: "Team <team@app.example>",
      subject: "Welcome aboard",
      message_data: { first_name: "Lin" },
    })
    await send.customerioSend(target("customerio"), "sms", {
      transactional_message_id: "1",
      identifiers: { id: "42" },
      to: "+12025550199",
      message_data: { body: "Your table is ready" },
    })
    const [email] = await harness.list({ service: "customerio", channel: "email" })
    expect(email).toMatchObject({
      to: "new@example.com",
      from: { name: "Team" },
      email: { subject: "Welcome aboard" },
      status: "pending",
    })
    expect(email?.email?.html).toContain("first_name")
    const [sms] = await harness.list({ service: "customerio", channel: "sms" })
    expect(sms).toMatchObject({ to: "+12025550199", sms: { body: "Your table is ready" } })
  })

  test("Mailosaur inbox email and SMS", async () => {
    await send.mailosaurIngest(target("mailosaur"), {
      to: "qa@srv.mailosaur.net",
      from: "Alerts <alerts@app.example>",
      subject: "Password reset",
      html: "<p>Reset: <a href='https://app.example/reset'>link</a></p>",
    })
    const [mail] = await harness.list({ service: "mailosaur" })
    expect(mail).toMatchObject({
      channel: "email",
      to: "qa@srv.mailosaur.net",
      email: { subject: "Password reset" },
    })
  })
})

test("namespaces stay apart, and reads see a send made just before them", async () => {
  await send.twilioSms(target("twilio"), { to: "+12025550111", body: "worker 3 only" }, "worker-3")
  expect(await harness.list({ to: "+12025550111" })).toHaveLength(0)
  const isolated = await harness.list({ namespace: "worker-3" })
  expect(isolated.map((n) => n.sms?.body)).toEqual(["worker 3 only"])
  expect(isolated[0]?.id).toStartWith("twilio:worker-3:")
})

test("waitFor resolves when the message arrives and times out with what it saw", async () => {
  const waiting = harness.waitFor(
    { channel: "sms", to: "+12025550144", contains: "later" },
    { timeoutMs: 5_000 },
  )
  setTimeout(
    () => void send.twilioSms(target("twilio"), { to: "+12025550144", body: "arrives later" }),
    150,
  )
  expect((await waiting)[0]?.sms?.body).toBe("arrives later")
  await expect(harness.waitFor({ to: "+19999999999" }, { timeoutMs: 200 })).rejects.toThrow(
    /timed out after 200ms/,
  )
})

test("a Resend message forwarded into Mailosaur appears once", async () => {
  const email = {
    from: "dup@app.example",
    to: ["dedupe@example.com"],
    subject: "Once",
    text: "only once",
  }
  await send.resendEmail(target("resend"), email)
  await send.mailosaurIngest(target("mailosaur"), email)
  const found = await harness.list({ to: "dedupe@example.com" })
  expect(found.map((n) => n.service)).toEqual(["resend"])
})

test("the HTTP API filters, reports sources, and serves the UI", async () => {
  const get = (path: string) => harness.fetch(new Request(`http://harness${path}`))
  const list = await (await get("/api/notifications?channel=push")).json()
  expect(list.notifications.every((n: { channel: string }) => n.channel === "push")).toBe(true)
  const latest = await (
    await get("/api/notifications/latest?service=twilio&to=%2B12025550123")
  ).json()
  expect(latest.sms.code).toMatch(/^\d{6}$/)
  const one = await (await get(`/api/notifications/${encodeURIComponent(latest.id)}`)).json()
  expect(one.id).toBe(latest.id)
  expect((await get("/api/notifications?channel=fax")).status).toBe(400)
  expect((await get("/api/wait?to=%2B19999999999&timeoutMs=50")).status).toBe(408)
  const sources = await (await get("/api/sources")).json()
  expect(sources.sources.map((s: { name: string; ok: boolean }) => [s.name, s.ok]).sort()).toEqual(
    ["customerio", "fcm", "mailosaur", "resend", "ses", "sns", "twilio"].map((n) => [n, true]),
  )
  const page = await get("/")
  expect(page.headers.get("content-type")).toContain("text/html")
  expect(await page.text()).toContain('src="./ui.js"')
  const script = await get("/ui.js")
  expect(script.headers.get("content-type")).toContain("javascript")
  expect((await script.text()).length).toBeGreaterThan(10_000)
  expect(
    (await harness.fetch(new Request("http://harness/api/notifications", { method: "POST" })))
      .status,
  ).toBe(405)
})

test("the event stream announces new notifications", async () => {
  const controller = new AbortController()
  const response = await harness.fetch(
    new Request("http://harness/api/events?namespace=sse", { signal: controller.signal }),
  )
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let text = ""
  const until = async (needle: string) => {
    while (!text.includes(needle)) text += decoder.decode((await reader.read()).value)
  }
  await until("event: hello")
  await send.twilioSms(target("twilio"), { to: "+12025550155", body: "streamed" }, "sse")
  await harness.sync("sse")
  await until("event: change")
  expect(text).toContain('"body":"streamed"')
  controller.abort()
})

test("parseMime decodes folded headers, encoded words and quoted-printable", () => {
  const parsed = parseMime(
    'Subject: =?utf-8?Q?Caf=C3=A9_menu?=\r\n =?utf-8?B?IOKYlQ==?=\r\nFrom: "Café" <cafe@example.com>\r\nTo: a@example.com, "B, Jr" <b@example.com>\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nSoup=3D=E2=82=AC4\r\n',
  )
  expect(parsed.subject).toBe("Café menu ☕")
  expect(parsed.to).toEqual(["a@example.com", '"B, Jr" <b@example.com>'])
  expect(parsed.text).toBe("Soup=€4")
})

test("in-process runtimes and aliases identified from the health route", async () => {
  const { createRuntime } = await import("@crvouga/mockingbird-service-fcm")
  const runtime = createRuntime()
  const local = createNotificationHarness({
    services: { phone: runtime, mail: servers.resend?.url ?? "" },
    pollIntervalMs: 0,
  })
  await send.fcmPush(
    { url: "http://fcm.local", fetch: (r) => runtime.fetch(r) },
    {
      token: "fixture-device-token",
      notification: { title: "In process", body: "No network" },
    },
  )
  const [push] = await local.list({ channel: "push" })
  expect(push).toMatchObject({ source: "phone", service: "fcm", push: { title: "In process" } })
  expect((await local.list({ source: "mail" })).every((n) => n.service === "resend")).toBe(true)
  local.close()
})
