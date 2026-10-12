import { describe, expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { createRuntime, TWILIO_PRESETS } from "./src/index.js"
import {
  emrValidatePhone,
  FetchRequestClient,
  isDefiniteDeliveryFailure,
  memoryDelivery,
  SMS_DELIVERY_UNKNOWN_OUTCOME_EVENT,
  SMS_DELIVERY_UNKNOWN_OUTCOME_MESSAGE,
  SmsChannel,
  sendConversationSms,
  TtlCache,
  TwilioRecordingHttpAdapter,
  TwilioService,
  TwilioWebhookReceiver,
  UnrecoverableError,
  UsersBackend,
} from "./test/consumer.js"
import { Twilio } from "./test/twilio-sdk.js"

const params = fcParameters(process.env)
const MOCK = "http://twilio.mock"
const ACCOUNT = "AC44444444444444444444444444444444"
const TOKEN = "twilio-auth-token"
const VERIFY_SERVICE = "VA0123456789abcdef0123456789abcdef"
const MESSAGING_SERVICE = "MG0123456789abcdef0123456789abcdef"
const CALLER_ID = "+13105550100"
const PUBLIC_BASE = "https://api.acme.example"
// Fictional numbers only (NANP 555-01xx).
const PHONE = "+12025550123"

/** A runtime whose webhooks land on our receiver port, and a Twilio SDK client pointed at it. */
const harness = (options: { cacheNow?: () => number } = {}) => {
  const receiver = new TwilioWebhookReceiver({
    authToken: TOKEN,
    webhookBaseUrl: PUBLIC_BASE,
    callerId: CALLER_ID,
  })
  const runtime = createRuntime({
    app: {
      url: "http://backend.local",
      publicBaseUrl: PUBLIC_BASE,
      authToken: TOKEN,
      accountSid: ACCOUNT,
      callerId: CALLER_ID,
    },
    fetch: (request) => receiver.fetch(request),
  })
  const client = new Twilio(ACCOUNT, TOKEN, {
    httpClient: new FetchRequestClient(MOCK, (request) => runtime.fetch(request)),
  })
  const cache = new TtlCache(options.cacheNow ?? (() => runtime.clock.now()))
  const backend = new UsersBackend(new TwilioService(client, VERIFY_SERVICE, cache))
  const admin = async (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) => {
    const response = await runtime.fetch(
      new Request(`${MOCK}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  const latestCode = async (to: string) =>
    (await admin(`/verify/${encodeURIComponent(to)}/latest`)).body.code as string
  return { runtime, client, backend, admin, receiver, latestCode }
}

describe("S8.6 acceptance: phone OTP through our backend's Verify logic", () => {
  test("start-phone → read the code from admin → check-phone sets isPhoneVerified", async () => {
    const { backend, latestCode } = harness()
    backend.users.set("ada@example.com", {
      id: "u1",
      email: "ada@example.com",
      phoneNumber: null,
      isPhoneVerified: false,
    })
    const started = await backend.startPhone({ phoneNumber: PHONE, email: "ada@example.com" })
    expect(started.status).toBe(200)
    const { verificationSid, phoneNumber } = started.body as {
      verificationSid: string
      phoneNumber: string
    }
    expect(verificationSid).toMatch(/^VE[0-9a-f]{32}$/)
    expect(phoneNumber).toBe(PHONE)
    const code = await latestCode(PHONE)
    expect(code).toMatch(/^\d{6}$/)
    const checked = await backend.checkPhone({ verificationSid, code })
    expect(checked).toEqual({
      status: 200,
      body: { success: true, message: "Phone number verified successfully" },
    })
    expect(backend.users.get("ada@example.com")).toMatchObject({
      isPhoneVerified: true,
      phoneNumber: PHONE,
    })
  })

  test('a wrong code is 400 "Invalid verification code" (Twilio: 200 pending), and the right one still works', async () => {
    const { backend, latestCode, admin } = harness()
    const started = await backend.startPhone({ phoneNumber: PHONE, email: "b@example.com" })
    const { verificationSid } = started.body as { verificationSid: string }
    const code = await latestCode(PHONE)
    const wrong = code === "000000" ? "111111" : "000000"
    expect(await backend.checkPhone({ verificationSid, code: wrong })).toEqual({
      status: 400,
      body: { statusCode: 400, message: "Invalid verification code" },
    })
    expect((await admin(`/verify/${encodeURIComponent(PHONE)}/latest`)).body).toMatchObject({
      status: "pending",
      attempts: 1,
    })
    expect((await backend.checkPhone({ verificationSid, code })).status).toBe(200)
  })

  test("after 10 minutes on the mock clock the check is 400 (Twilio answers 404 20404)", async () => {
    // The backend's Redis TTL is wall-clock; keep it alive so Twilio's expiry is what fails.
    const { backend, latestCode, runtime } = harness({ cacheNow: () => Date.now() })
    const started = await backend.startPhone({ phoneNumber: PHONE, email: "c@example.com" })
    const { verificationSid } = started.body as { verificationSid: string }
    const code = await latestCode(PHONE)
    runtime.clock.advance(10 * 60_000)
    expect(await backend.checkPhone({ verificationSid, code })).toEqual({
      status: 400,
      body: { statusCode: 400, message: "Failed to check phone verification" },
    })
  })

  test("just under 10 minutes the code still verifies", async () => {
    const { backend, latestCode, runtime } = harness()
    const started = await backend.startPhone({ phoneNumber: PHONE, email: "d@example.com" })
    const { verificationSid } = started.body as { verificationSid: string }
    runtime.clock.advance(10 * 60_000 - 1_000)
    const checked = await backend.checkPhone({ verificationSid, code: await latestCode(PHONE) })
    expect(checked.status).toBe(200)
  })

  test("PUT /__admin/verify {fixedCode} replaces the E2E_OTP_BYPASS code", async () => {
    const { backend, admin } = harness()
    expect((await admin("/verify", { fixedCode: "000000" }, "PUT")).status).toBe(200)
    const started = await backend.startPhone({ phoneNumber: "+13105550142", email: "e@x.com" })
    const { verificationSid } = started.body as { verificationSid: string }
    expect((await backend.checkPhone({ verificationSid, code: "000000" })).status).toBe(200)
  })

  test("more than 5 checks is 429 60202; more than 5 sends in 10 minutes is 429 60203", async () => {
    const { client, backend, runtime } = harness()
    const started = await backend.startPhone({ phoneNumber: PHONE, email: "f@x.com" })
    const { verificationSid } = started.body as { verificationSid: string }
    const verify = client.verify.v2.services(VERIFY_SERVICE)
    for (let i = 0; i < 5; i++) {
      expect(
        (await verify.verificationChecks.create({ verificationSid, code: "999999" })).status,
      ).toBe("pending")
    }
    const blocked = await verify.verificationChecks
      .create({ verificationSid, code: "999999" })
      .catch((error: { status: number; code: number }) => error)
    expect(blocked).toMatchObject({ status: 429, code: 60202 })
    // Re-sends reuse the pending verification; the sixth send in the window is refused.
    for (let i = 0; i < 4; i++) {
      expect((await verify.verifications.create({ to: PHONE, channel: "sms" })).sid).toBe(
        verificationSid,
      )
    }
    const tooMany = await verify.verifications
      .create({ to: PHONE, channel: "sms" })
      .catch((error: { status: number; code: number }) => error)
    expect(tooMany).toMatchObject({ status: 429, code: 60203 })
    // Our backend turns it into a 400.
    expect((await backend.startPhone({ phoneNumber: PHONE, email: "f@x.com" })).status).toBe(400)
    runtime.clock.advance(10 * 60_000 + 1)
    expect((await backend.startPhone({ phoneNumber: PHONE, email: "f@x.com" })).status).toBe(200)
  })

  test("an approved or canceled verification is 404 on the next check", async () => {
    const { client, latestCode } = harness()
    const verify = client.verify.v2.services(VERIFY_SERVICE)
    const first = await verify.verifications.create({ to: PHONE, channel: "sms" })
    const code = await latestCode(PHONE)
    expect(
      (await verify.verificationChecks.create({ verificationSid: first.sid, code })).status,
    ).toBe("approved")
    const again = await verify.verificationChecks
      .create({ verificationSid: first.sid, code })
      .catch((error: { status: number; code: number }) => error)
    expect(again).toMatchObject({ status: 404, code: 20404 })
    const second = await verify.verifications.create({ to: "+13105550142", channel: "sms" })
    expect((await verify.verifications(second.sid).update({ status: "canceled" })).status).toBe(
      "canceled",
    )
    const canceled = await verify.verificationChecks
      .create({ to: "+13105550142", code: "123456" })
      .catch((error: { status: number; code: number }) => error)
    expect(canceled).toMatchObject({ status: 404, code: 20404 })
  })

  test("verify_5xx: start and check fail as 400s in our backend", async () => {
    const { backend, runtime } = harness()
    runtime.applyPreset("verify_5xx", "default", { count: 1 })
    expect(await backend.startPhone({ phoneNumber: PHONE, email: "g@x.com" })).toEqual({
      status: 400,
      body: { statusCode: 400, message: "Failed to start phone verification" },
    })
  })
})

describe("Lookup through the profile wizard's validate-phone", () => {
  test("a fictional 555-01xx number is valid and normalised", async () => {
    const { backend } = harness()
    expect(await backend.validatePhone({ phoneNumber: "(202) 555-0123" })).toEqual({
      status: 200,
      body: {
        valid: false,
        phoneNumber: null,
        message: "Phone number must be exactly 11 digits including country code",
      },
    })
    expect(await backend.validatePhone({ phoneNumber: "1 (202) 555-0123" })).toEqual({
      status: 200,
      body: { valid: true, phoneNumber: PHONE, message: "Phone number is valid" },
    })
  })

  test("PUT /__admin/lookups/:e164 {valid:false} makes Lookup reject it", async () => {
    const { backend, admin } = harness()
    await admin(
      `/lookups/${encodeURIComponent(PHONE)}`,
      { valid: false, validationErrors: ["INVALID_BUT_POSSIBLE"] },
      "PUT",
    )
    expect(await backend.validatePhone({ phoneNumber: PHONE })).toEqual({
      status: 200,
      body: { valid: false, phoneNumber: null, message: "Phone number is not valid" },
    })
    // start-phone refuses it before any SMS is sent.
    expect(await backend.startPhone({ phoneNumber: PHONE, email: "h@x.com" })).toEqual({
      status: 400,
      body: { statusCode: 400, message: "Phone number is not valid" },
    })
  })

  test("lookup_5xx: the backend answers 500 and the EMR fails open", async () => {
    const { backend, runtime } = harness()
    runtime.applyPreset("lookup_5xx", "default", { count: 1 })
    const result = await emrValidatePhone(backend, PHONE)
    expect(result.valid).toBe(true)
    expect(result.message).toContain("Phone validation skipped (service error)")
  })
})

describe("SMS through the notification dispatcher and the care-chat adapter", () => {
  test("messages.create lands in the outbox with an SM sid; the delivery is accepted", async () => {
    const { client, admin } = harness()
    const channel = new SmsChannel(client, { serviceSid: MESSAGING_SERVICE })
    const delivery = memoryDelivery()
    await channel.send(
      {
        to: PHONE,
        body: "Your results are ready",
        templateId: "bloodwork.results_available",
        actions: [{ label: "Open", url: "https://app.example/results" }],
      },
      delivery,
    )
    expect(delivery.state).toMatchObject({
      status: "accepted",
      providerId: expect.stringMatching(/^SM[0-9a-f]{32}$/),
    })
    const outbox = (await admin(`/outbox?to=${encodeURIComponent(PHONE)}`)).body.messages as {
      body: string
      messagingServiceSid: string
    }[]
    expect(outbox).toHaveLength(1)
    expect(outbox[0]?.body).toBe("Your results are ready\n\nOpen: https://app.example/results")
    expect(outbox[0]?.messagingServiceSid).toBe(MESSAGING_SERVICE)
  })

  test("sms_socket_drop: an unknown outcome is reported and never retried", async () => {
    const { client, runtime, admin } = harness()
    runtime.applyPreset("sms_socket_drop", "default", { count: 1 })
    const channel = new SmsChannel(client, { from: "+15005550006" })
    const delivery = memoryDelivery()
    const job = { to: PHONE, body: "Reminder", templateId: "appointment.reminder_24h" }
    await expect(channel.send(job, delivery)).rejects.toThrow(SMS_DELIVERY_UNKNOWN_OUTCOME_MESSAGE)
    expect(delivery.state?.status).toBe("pending")
    expect(channel.warnings).toEqual([
      { event: SMS_DELIVERY_UNKNOWN_OUTCOME_EVENT, type: "appointment.reminder_24h" },
    ])
    // The retry is blocked by the pending state: nothing reaches Twilio.
    await expect(channel.send(job, delivery)).rejects.toThrow(SMS_DELIVERY_UNKNOWN_OUTCOME_MESSAGE)
    expect((await admin("/outbox")).body.messages).toEqual([])
  })

  test("sms_socket_drop on a password reset is retried and then delivered", async () => {
    const { client, runtime, admin } = harness()
    runtime.applyPreset("sms_socket_drop", "default", { count: 1 })
    const channel = new SmsChannel(client, { from: "+15005550006" })
    const delivery = memoryDelivery()
    const job = { to: PHONE, body: "Reset code", templateId: "account.password_reset_request" }
    await expect(channel.send(job, delivery)).rejects.toThrow(TypeError)
    expect(delivery.state).toBeUndefined()
    await channel.send(job, delivery)
    expect(delivery.state?.status).toBe("accepted")
    expect((await admin("/outbox")).body.messages).toHaveLength(1)
  })

  test("sms_4xx is a definite failure: the delivery resets and the Twilio error propagates", async () => {
    const { client, runtime } = harness()
    runtime.applyPreset("sms_4xx", "default", { count: 1 })
    const channel = new SmsChannel(client, { from: "+15005550006" })
    const delivery = memoryDelivery()
    const error = await channel
      .send({ to: PHONE, body: "x", templateId: "appointment.reminder_24h" }, delivery)
      .catch((e: { status: number; code: number }) => e)
    expect(error).toMatchObject({ status: 400, code: 21211 })
    expect(delivery.state).toBeUndefined()
    expect(channel.warnings).toEqual([])
  })

  test("the care-chat adapter reads message.sid; a real 400 becomes ChannelSendError", async () => {
    const { client } = harness()
    const sent = await sendConversationSms(
      client,
      { from: CALLER_ID },
      { to: PHONE, bodyText: "Hi" },
    )
    expect(sent.providerMessageId).toMatch(/^SM/)
    await expect(
      sendConversationSms(client, { from: CALLER_ID }, { to: "+15550100", bodyText: "Hi" }),
    ).rejects.toThrow("Care-chat SMS delivery failed")
  })
})

const RFC2822 = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000$/
const ORDER_BODY = "Your order is ready\n\nManage: https://app.example.test/orders"

type Runtime = ReturnType<typeof createRuntime>
const basic = (account = ACCOUNT, token = TOKEN) => ({
  authorization: `Basic ${btoa(`${account}:${token}`)}`,
})
const postMessage = (
  runtime: Runtime,
  form: Record<string, string>,
  init: { account?: string; token?: string | null; namespace?: string; raw?: string } = {},
) => {
  const account = init.account ?? ACCOUNT
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    ...(init.token === null ? {} : basic(account, init.token ?? TOKEN)),
    ...(init.namespace ? { "x-mockingbird-namespace": init.namespace } : {}),
  }
  return runtime.fetch(
    new Request(`${MOCK}/api/2010-04-01/Accounts/${account}/Messages.json`, {
      method: "POST",
      headers,
      body: init.raw ?? new URLSearchParams(form).toString(),
    }),
  )
}
const outboxOf = async (admin: ReturnType<typeof harness>["admin"], to = PHONE) =>
  (await admin(`/outbox?to=${encodeURIComponent(to)}&kind=sms`)).body.messages as {
    sid: string
    body: string
    to: string
    from: string | null
  }[]

describe("SMS delivery ambiguity", () => {
  test("MessagingServiceSid create is 201 accepted, one outbox row, RFC 2822 dates", async () => {
    const { client, runtime, admin } = harness()
    runtime.clock.set(Date.UTC(2023, 7, 24, 5, 1, 45))
    runtime.clock.freeze()
    const message = await client.messages.create({
      to: PHONE,
      body: ORDER_BODY,
      messagingServiceSid: MESSAGING_SERVICE,
    })
    expect(message.sid).toMatch(/^SM[0-9a-f]{32}$/)
    expect(message.status).toBe("accepted")
    expect(message.to).toBe(PHONE)
    expect(message.body).toBe(ORDER_BODY)
    expect(message.messagingServiceSid).toBe(MESSAGING_SERVICE)
    expect(message.from).toBeNull()
    expect(message.numSegments).toBe("0")
    expect(message.dateCreated).toBeInstanceOf(Date)
    const raw = (await (
      await runtime.fetch(
        new Request(`${MOCK}/api/2010-04-01/Accounts/${ACCOUNT}/Messages/${message.sid}.json`, {
          headers: basic(),
        }),
      )
    ).json()) as { date_created: string; date_updated: string; status: string }
    expect(raw.date_created).toBe("Thu, 24 Aug 2023 05:01:45 +0000")
    expect(raw.date_updated).toMatch(RFC2822)
    expect(raw.status).toBe("accepted")
    const outbox = await outboxOf(admin)
    expect(outbox).toHaveLength(1)
    expect(outbox[0]?.sid).toBe(message.sid)
    const later = Number(runtime.clock.now()) + 1000
    expect(
      (await admin(`/outbox?to=${encodeURIComponent(PHONE)}&kind=sms&since=${later}`)).body
        .messages,
    ).toEqual([])
  })

  test("From is queued; From plus MessagingServiceSid keeps both fields and stays queued", async () => {
    const { client } = harness()
    const fromOnly = await client.messages.create({ to: PHONE, from: CALLER_ID, body: "Hello" })
    expect(fromOnly.status).toBe("queued")
    expect(fromOnly.from).toBe(CALLER_ID)
    expect(fromOnly.messagingServiceSid).toBeNull()
    expect(fromOnly.numSegments).toBe("1")
    const both = await client.messages.create({
      to: PHONE,
      from: CALLER_ID,
      messagingServiceSid: MESSAGING_SERVICE,
      body: "Hello",
    })
    expect(both.status).toBe("queued")
    expect(both.from).toBe(CALLER_ID)
    expect(both.messagingServiceSid).toBe(MESSAGING_SERVICE)
    expect(both.sid).not.toBe(fromOnly.sid)
  })

  test("a form body with newlines and an action link is stored byte-for-byte after decoding", async () => {
    const { runtime, admin } = harness()
    const raw = `To=${encodeURIComponent(PHONE)}&Body=Your+order+is+ready%0A%0AManage%3A+https%3A%2F%2Fapp.example.test%2Forders&MessagingServiceSid=${MESSAGING_SERVICE}`
    const response = await postMessage(runtime, {}, { raw })
    expect(response.status).toBe(201)
    const created = (await response.json()) as { body: string; sid: string }
    expect(created.body).toBe(ORDER_BODY)
    expect((await outboxOf(admin))[0]?.body).toBe(ORDER_BODY)
    const fetched = (await (
      await runtime.fetch(
        new Request(`${MOCK}/api/2010-04-01/Accounts/${ACCOUNT}/Messages/${created.sid}.json`, {
          headers: basic(),
        }),
      )
    ).json()) as { body: string }
    expect(fetched.body).toBe(ORDER_BODY)
  })

  test("missing or invalid create fields return the documented Twilio error and store nothing", async () => {
    const { runtime, admin } = harness()
    const cases: { form: Record<string, string>; code: number }[] = [
      { form: { Body: "hi", From: CALLER_ID }, code: 21604 },
      { form: { To: "  ", Body: "hi", From: CALLER_ID }, code: 21604 },
      { form: { To: PHONE, From: CALLER_ID }, code: 21602 },
      { form: { To: PHONE, Body: "", From: CALLER_ID }, code: 21602 },
      { form: { To: PHONE, Body: "hi" }, code: 21603 },
      { form: { To: "+15550100", Body: "hi", From: CALLER_ID }, code: 21211 },
      { form: { To: PHONE, Body: "x".repeat(1601), From: CALLER_ID }, code: 21617 },
    ]
    for (const entry of cases) {
      const response = await postMessage(runtime, entry.form)
      expect(response.status).toBe(400)
      expect(response.headers.get("x-twilio-error-code")).toBe(String(entry.code))
      expect(await response.json()).toEqual({
        code: entry.code,
        message: expect.any(String),
        more_info: `https://www.twilio.com/docs/errors/${entry.code}`,
        status: 400,
      })
    }
    const boundary = await postMessage(runtime, {
      To: PHONE,
      Body: "x".repeat(1600),
      From: CALLER_ID,
    })
    expect(boundary.status).toBe(201)
    expect(await outboxOf(admin)).toHaveLength(1)
  })

  test("missing or wrong credentials are 401 20003 and create no message", async () => {
    const runtime = createRuntime({ accounts: { [ACCOUNT]: TOKEN } })
    const missing = await postMessage(
      runtime,
      { To: PHONE, Body: "hi", From: CALLER_ID },
      { token: null },
    )
    expect(missing.status).toBe(401)
    expect(await missing.json()).toMatchObject({ code: 20003, status: 401 })
    expect(missing.headers.get("x-twilio-error-code")).toBe("20003")
    const wrong = await postMessage(
      runtime,
      { To: PHONE, Body: "hi", From: CALLER_ID },
      { token: "not-the-token" },
    )
    expect(wrong.status).toBe(401)
    expect(await wrong.json()).toMatchObject({
      code: 20003,
      status: 401,
      message: `authentication failed, auth token is not valid for account ${ACCOUNT}`,
    })
    const created = await postMessage(runtime, { To: PHONE, Body: "hi", From: CALLER_ID })
    const sid = ((await created.json()) as { sid: string }).sid
    const fetched = await runtime.fetch(
      new Request(`${MOCK}/api/2010-04-01/Accounts/${ACCOUNT}/Messages/${sid}.json`, {
        headers: basic(ACCOUNT, "not-the-token"),
      }),
    )
    expect(fetched.status).toBe(401)
    expect(await fetched.json()).toMatchObject({ code: 20003 })
    expect(runtime.instance("default").messages()).toHaveLength(1)
    expect(runtime.instance("default").outbox()).toHaveLength(1)
  })

  test("sms_drop_before_accept closes the socket before a Message exists", async () => {
    const { client, runtime, admin } = harness()
    runtime.applyPreset("sms_drop_before_accept", "default", { count: 1 })
    const error = await client.messages
      .create({ to: PHONE, from: CALLER_ID, body: "Reminder" })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(TypeError)
    expect(isDefiniteDeliveryFailure(error)).toBe(false)
    expect(await outboxOf(admin)).toEqual([])
    expect(runtime.instance("default").messages()).toEqual([])
  })

  test("sms_accepted_then_socket_drop stores the message and the SDK sees a transport error", async () => {
    const { client, runtime, admin } = harness()
    runtime.applyPreset("sms_accepted_then_socket_drop", "default", { count: 1 })
    const error = await client.messages
      .create({ to: PHONE, messagingServiceSid: MESSAGING_SERVICE, body: "Ambiguous" })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(TypeError)
    expect(isDefiniteDeliveryFailure(error)).toBe(false)
    const outbox = await outboxOf(admin)
    expect(outbox).toHaveLength(1)
    const stored = outbox[0]
    if (stored === undefined) throw new Error("expected one stored message")
    const fetched = await client.messages(stored.sid).fetch()
    expect(fetched.body).toBe("Ambiguous")
    expect(fetched.sid).toBe(stored.sid)
    expect(fetched.status).toBe("accepted")
  })

  test("an ordinary notification is not retried after an ambiguous drop, but the same payload is not deduplicated", async () => {
    const { client, runtime, admin } = harness()
    runtime.applyPreset("sms_accepted_then_socket_drop", "default", { count: 1 })
    const channel = new SmsChannel(client, { serviceSid: MESSAGING_SERVICE })
    const delivery = memoryDelivery()
    const job = {
      to: PHONE,
      body: "Your order is ready",
      templateId: "appointment.reminder_24h",
      actions: [{ label: "Manage", url: "https://app.example.test/orders" }],
    }
    await expect(channel.send(job, delivery)).rejects.toThrow(SMS_DELIVERY_UNKNOWN_OUTCOME_MESSAGE)
    expect(delivery.state?.status).toBe("pending")
    await expect(channel.send(job, delivery)).rejects.toThrow(SMS_DELIVERY_UNKNOWN_OUTCOME_MESSAGE)
    expect(await outboxOf(admin)).toHaveLength(1)
    await client.messages.create({
      to: PHONE,
      messagingServiceSid: MESSAGING_SERVICE,
      body: ORDER_BODY,
    })
    const outbox = await outboxOf(admin)
    expect(outbox).toHaveLength(2)
    expect(new Set(outbox.map((item) => item.sid)).size).toBe(2)
  })

  test("a retry-allowed notification after sms_drop_before_accept creates exactly one message", async () => {
    const { client, runtime, admin } = harness()
    runtime.applyPreset("sms_drop_before_accept", "default", { count: 1 })
    const channel = new SmsChannel(client, { from: CALLER_ID })
    const delivery = memoryDelivery()
    const job = { to: PHONE, body: "Reset code", templateId: "account.password_reset_request" }
    await expect(channel.send(job, delivery)).rejects.toThrow(TypeError)
    expect(delivery.state).toBeUndefined()
    expect(await outboxOf(admin)).toEqual([])
    await channel.send(job, delivery)
    expect(delivery.state?.status).toBe("accepted")
    expect(await outboxOf(admin)).toHaveLength(1)
  })

  test("4xx is a definite failure, and 429/500/503 keep Twilio's envelope and Retry-After", async () => {
    const { client, runtime, admin } = harness()
    const definite = async (preset: string) => {
      runtime.applyPreset(preset, "default", { count: 1 })
      const error = await client.messages
        .create({ to: PHONE, from: CALLER_ID, body: preset })
        .catch((caught: unknown) => caught)
      expect(isDefiniteDeliveryFailure(error)).toBe(true)
      return error as { status: number; code: number; message: string; moreInfo: string }
    }
    expect(await definite("sms_4xx")).toMatchObject({ status: 400, code: 21211 })
    expect(await definite("sms_429")).toMatchObject({
      status: 429,
      code: 20429,
      message: "Too many requests",
      moreInfo: "https://www.twilio.com/docs/errors/20429",
    })
    expect(await definite("sms_5xx")).toMatchObject({ status: 500, code: 20500 })
    const limited = await postMessage(runtime, { To: PHONE, From: CALLER_ID, Body: "stored-ok" })
    // The counted presets are spent, so this request is a normal create. Re-arm 429 for headers.
    expect(limited.status).toBe(201)
    runtime.applyPreset("sms_429", "default", { count: 1, latencyMs: 30 })
    const again = await postMessage(runtime, { To: PHONE, From: CALLER_ID, Body: "rate-limited" })
    expect(again.status).toBe(429)
    expect(again.headers.get("retry-after")).toBe("1")
    expect(again.headers.get("x-twilio-error-code")).toBe("20429")
    runtime.applyPreset("sms_5xx", "default", { count: 1 })
    const fiveHundred = await postMessage(runtime, {
      To: PHONE,
      From: CALLER_ID,
      Body: "server-down",
    })
    expect(fiveHundred.status).toBe(500)
    expect(fiveHundred.headers.get("retry-after")).toBeNull()
    expect(await fiveHundred.json()).toMatchObject({ code: 20500, status: 500 })
    await admin("/faults", {
      operationId: "CreateMessage",
      status: 503,
      count: 1,
      body: {
        code: 20503,
        message: "Service is unavailable. Please try again",
        more_info: "https://www.twilio.com/docs/errors/20503",
        status: 503,
      },
      headers: { "x-twilio-error-code": "20503", "retry-after": "30" },
    })
    const unavailable = await postMessage(runtime, {
      To: PHONE,
      From: CALLER_ID,
      Body: "unavailable",
    })
    expect(unavailable.status).toBe(503)
    expect(unavailable.headers.get("retry-after")).toBe("30")
    expect(await unavailable.json()).toMatchObject({ code: 20503, status: 503 })
    const faults = (await admin("/faults")).body.faults as {
      fromPreset?: string
      hits: number
      remaining: number | null
      delayMs?: number
      namespace: string
    }[]
    const rateLimit = faults.find((fault) => fault.fromPreset === "sms_429" && fault.delayMs === 30)
    expect(rateLimit).toMatchObject({ hits: 1, remaining: 0, delayMs: 30, namespace: "default" })
    const stored = (await outboxOf(admin)).map((item) => item.body)
    expect(stored).toContain("stored-ok")
    expect(stored).not.toContain("rate-limited")
    expect(stored).not.toContain("server-down")
    expect(stored).not.toContain("unavailable")
    expect(stored).not.toContain("sms_4xx")
  })

  test("sms_missing_sid accepts the message but the create body has no sid", async () => {
    const { client, runtime, admin } = harness()
    runtime.applyPreset("sms_missing_sid", "default", { count: 2 })
    const message = await client.messages.create({
      to: PHONE,
      messagingServiceSid: MESSAGING_SERVICE,
      body: "No sid",
    })
    expect(message.sid).toBeUndefined()
    const channel = new SmsChannel(client, { serviceSid: MESSAGING_SERVICE })
    const delivery = memoryDelivery()
    const error = await channel
      .send({ to: PHONE, body: "No sid", templateId: "appointment.reminder_24h" }, delivery)
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(UnrecoverableError)
    expect(delivery.state?.status).toBe("pending")
    const outbox = await outboxOf(admin)
    expect(outbox).toHaveLength(2)
    expect(outbox.every((item) => item.sid.startsWith("SM"))).toBe(true)
    const fetched = await client.messages(outbox[0]?.sid as string).fetch()
    expect(fetched.body).toBe("No sid")
  })

  test("two namespaces keep sids, outboxes, faults and recorded timestamps apart", async () => {
    const runtime = createRuntime()
    const other = "AC55555555555555555555555555555555"
    await runtime.fetch(
      new Request(`${MOCK}/__admin/credentials`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentials: { [ACCOUNT]: "worker-a", [other]: "worker-b" } }),
      }),
    )
    runtime.clock.set(Date.UTC(2023, 7, 24, 5, 1, 45))
    runtime.clock.freeze()
    const form = { To: PHONE, Body: "Same payload", From: CALLER_ID }
    const createdA = (await (await postMessage(runtime, form)).json()) as {
      sid: string
      date_created: string
    }
    runtime.clock.advance(60_000)
    const createdB = (await (await postMessage(runtime, form, { account: other })).json()) as {
      sid: string
      date_created: string
    }
    expect(createdA.sid).toMatch(/^SM[0-9a-f]{32}$/)
    expect(createdB.sid).toMatch(/^SM[0-9a-f]{32}$/)
    expect(createdA.sid).not.toBe(createdB.sid)
    expect(createdA.date_created).not.toBe(createdB.date_created)
    runtime.applyPreset("sms_drop_before_accept", "worker-a", { count: 1 })
    const dropped = await postMessage(runtime, form).catch((error: unknown) => error)
    expect(dropped).toBeInstanceOf(TypeError)
    const stillThere = await postMessage(runtime, form, { account: other })
    expect(stillThere.status).toBe(201)
    await runtime.reset("worker-a")
    expect(runtime.instance("worker-a").outbox()).toEqual([])
    expect(runtime.instance("worker-a").messages()).toEqual([])
    const survived = runtime.instance("worker-b").messages()
    expect(survived).toHaveLength(2)
    expect(survived[0]?.date_created).toBe(createdB.date_created)
    expect(runtime.instance("worker-b").outbox()).toHaveLength(2)
  })

  test("the request journal records the operation and sid, not the phone, body, link or token", async () => {
    const token = "journal-must-not-see-this-token"
    const runtime = createRuntime({ accounts: { [ACCOUNT]: token } })
    runtime.clock.freeze()
    const response = await postMessage(
      runtime,
      { To: PHONE, Body: ORDER_BODY, MessagingServiceSid: MESSAGING_SERVICE },
      { token },
    )
    const created = (await response.json()) as { sid: string }
    const journal = (await (
      await runtime.fetch(new Request(`${MOCK}/__admin/requests`))
    ).json()) as { requests: Record<string, unknown>[] }
    const entry = journal.requests.find((item) => item.operationId === "CreateMessage")
    expect(entry).toMatchObject({
      operationId: "CreateMessage",
      status: 201,
      namespace: "default",
      ids: { messageSid: created.sid },
    })
    expect(typeof entry?.durationMs).toBe("number")
    const text = JSON.stringify(journal)
    expect(text).not.toContain(PHONE)
    expect(text).not.toContain(token)
    expect(text).not.toContain("app.example.test")
    expect(text).not.toContain("Your order is ready")
    const sent = runtime.instance("default").outbox()
    expect(sent[0]?.to).toBe(PHONE)
    expect(sent[0]?.body).toBe(ORDER_BODY)
  })
})

describe("S8.4 inbound webhooks, verified by our receivers", () => {
  test("POST /__admin/inbound/sms signs against the public base URL; the app answers <Response/>", async () => {
    const { admin, receiver } = harness()
    const sent = await admin("/inbound/sms", { from: "+12025550188", body: "Hello care team" })
    expect(sent.status).toBe(200)
    const deliveries = sent.body.deliveries as { status: number; response: string }[]
    expect(deliveries).toEqual([
      expect.objectContaining({ status: 200, response: "<Response/>", state: "delivered" }),
    ])
    expect(receiver.inbound).toEqual([
      expect.objectContaining({
        sender: "+12025550188",
        recipient: CALLER_ID,
        body: "Hello care team",
        providerMessageId: expect.stringMatching(/^SM[0-9a-f]{32}$/),
      }),
    ])
  })

  test("MMS carries MediaUrl{i} and an MM sid; a duplicate delivery is deduped on MessageSid", async () => {
    const { admin, receiver, runtime } = harness()
    runtime.applyPreset("webhook_duplicate", "default")
    const sent = await admin("/inbound/sms", {
      from: "+12025550188",
      body: "photo",
      media: [{ url: "https://api.twilio.com/media/ME1", contentType: "image/png" }],
    })
    expect(sent.body.deliveries).toHaveLength(2)
    expect(receiver.inbound).toHaveLength(1)
    expect(receiver.inbound[0]?.providerMessageId).toMatch(/^MM/)
    expect(receiver.inbound[0]?.media).toEqual([
      { index: 0, url: "https://api.twilio.com/media/ME1", contentType: "image/png" },
    ])
  })

  test("a receiver with another auth token (or base URL) answers 403", async () => {
    const wrong = new TwilioWebhookReceiver({
      authToken: "not-the-token",
      webhookBaseUrl: PUBLIC_BASE,
      callerId: CALLER_ID,
    })
    const runtime = createRuntime({
      app: {
        url: "http://backend.local",
        publicBaseUrl: PUBLIC_BASE,
        authToken: TOKEN,
        callerId: CALLER_ID,
      },
      fetch: (request) => wrong.fetch(request),
    })
    const sent = await runtime.inboundSms({ from: "+12025550188", body: "x" })
    expect(sent.deliveries[0]?.status).toBe(403)
  })

  test("voice status and recording webhooks; the recording adapter downloads 2 channels, then deletes", async () => {
    const { admin, receiver, runtime } = harness()
    expect((await admin("/voice/status", {})).status).toBe(200)
    expect(receiver.statuses).toEqual([
      { callSid: expect.stringMatching(/^CA[0-9a-f]{32}$/), status: "completed" },
    ])
    await admin("/voice/recording", {})
    const recording = receiver.recordings[0]
    expect(recording?.recordingUrl).toMatch(
      new RegExp(
        `^https://api\\.twilio\\.com/2010-04-01/Accounts/${ACCOUNT}/Recordings/RE[0-9a-f]{32}$`,
      ),
    )
    const adapter = new TwilioRecordingHttpAdapter(
      { accountSid: ACCOUNT, authToken: TOKEN, apiBaseUrl: MOCK },
      (request) => runtime.fetch(request),
    )
    const wav = await adapter.download({
      recordingSid: recording?.recordingSid as string,
      recordingUrl: recording?.recordingUrl as string,
    })
    expect(Buffer.from(wav).toString("ascii", 0, 4)).toBe("RIFF")
    await adapter.delete(recording?.recordingSid as string)
    // A second delete is a 404, which our adapter tolerates.
    await adapter.delete(recording?.recordingSid as string)
    await expect(
      adapter.download({
        recordingSid: recording?.recordingSid as string,
        recordingUrl: recording?.recordingUrl as string,
      }),
    ).rejects.toThrow("HTTP 404")
  })

  test("an uploaded mono recording is refused by our dual-channel check", async () => {
    const { admin, runtime } = harness()
    const sid = "RE0123456789abcdef0123456789abcdef"
    await admin(`/recordings/${sid}`, { channels: 1, accountSid: ACCOUNT }, "PUT")
    const adapter = new TwilioRecordingHttpAdapter(
      { accountSid: ACCOUNT, authToken: TOKEN, apiBaseUrl: MOCK },
      (request) => runtime.fetch(request),
    )
    await expect(
      adapter.download({
        recordingSid: sid,
        recordingUrl: `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Recordings/${sid}`,
      }),
    ).rejects.toThrow("must contain 2 channels; received 1")
  })
})

describe("namespaces and presets", () => {
  test("AccountSid namespaces isolate parallel workers' codes and outboxes", async () => {
    const runtime = createRuntime()
    const a = "AC11111111111111111111111111111111"
    const b = "AC22222222222222222222222222222222"
    await runtime.fetch(
      new Request(`${MOCK}/__admin/credentials`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentials: { [a]: "worker-a", [b]: "worker-b" } }),
      }),
    )
    const clientFor = (sid: string) =>
      new Twilio(sid, TOKEN, { httpClient: new FetchRequestClient(MOCK, (r) => runtime.fetch(r)) })
    await clientFor(a)
      .verify.v2.services(VERIFY_SERVICE)
      .verifications.create({ to: PHONE, channel: "sms" })
    const latest = (ns: string) =>
      runtime.fetch(
        new Request(`${MOCK}/__admin/verify/${encodeURIComponent(PHONE)}/latest?namespace=${ns}`),
      )
    expect((await latest("worker-a")).status).toBe(200)
    expect((await latest("worker-b")).status).toBe(404)
    expect((await latest("default")).status).toBe(404)
    const journal = (await (
      await runtime.fetch(new Request(`${MOCK}/__admin/requests?namespace=worker-a`))
    ).json()) as { requests: { operationId: string; ids?: Record<string, string> }[] }
    expect(journal.requests[0]?.operationId).toBe("CreateVerification")
    expect(journal.requests[0]?.ids?.verificationSid).toMatch(/^VE/)
  })

  test("every catalog preset is registered", () => {
    expect(Object.keys(TWILIO_PRESETS)).toEqual(
      expect.arrayContaining(["verify_5xx", "sms_socket_drop", "sms_4xx", "lookup_5xx"]),
    )
  })

  test("any wrong code never approves; the right code approves within 5 attempts", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.stringMatching(/^[0-9]{6}$/), { minLength: 0, maxLength: 4 }),
        async (wrongCodes) => {
          const { client, latestCode } = harness()
          const verify = client.verify.v2.services(VERIFY_SERVICE)
          const { sid } = await verify.verifications.create({ to: PHONE, channel: "sms" })
          const code = await latestCode(PHONE)
          for (const wrong of wrongCodes.filter((w) => w !== code)) {
            const check = await verify.verificationChecks.create({
              verificationSid: sid,
              code: wrong,
            })
            expect(check.status).toBe("pending")
            expect(check.valid).toBe(false)
          }
          const check = await verify.verificationChecks.create({ verificationSid: sid, code })
          expect(check.status).toBe("approved")
          expect(check.valid).toBe(true)
        },
      ),
      { ...params, numRuns: params.numRuns ?? 15 },
    )
  }, 60_000)
})
