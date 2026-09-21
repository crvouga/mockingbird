import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { request as httpRequest } from "node:http"
import { Twilio, validateRequest } from "twilio"
import { synthesizeWav } from "./src/index.js"
import { createServer, type TwilioServer } from "./src/server.js"
import {
  MockRequestClient,
  memoryDelivery,
  SMS_DELIVERY_UNKNOWN_OUTCOME_MESSAGE,
  SmsChannel,
  TwilioRecordingHttpAdapter,
  TwilioWebhookReceiver,
} from "./test/consumer.js"

/**
 * The official twilio-node SDK (5.10.0, the version our consumer pins) pointed at the served
 * mock through the G-T1 seam: its own axios `RequestClient`, with hosts rewritten.
 */
const ACCOUNT = "AC44444444444444444444444444444444"
const TOKEN = "sdk-auth-token"
const VERIFY_SERVICE = "VA0123456789abcdef0123456789abcdef"
const CALLER_ID = "+13105550100"
const PUBLIC_BASE = "https://api.geviti.example"
const PHONE = "+12025550123"

let server: TwilioServer
let sink: ReturnType<typeof Bun.serve>
const captured: { url: string; signature: string | null; params: Record<string, string> }[] = []
const receiver = new TwilioWebhookReceiver({
  authToken: TOKEN,
  webhookBaseUrl: PUBLIC_BASE,
  callerId: CALLER_ID,
})

beforeAll(async () => {
  sink = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const copy = request.clone()
      captured.push({
        url: new URL(request.url).pathname,
        signature: request.headers.get("x-twilio-signature"),
        params: Object.fromEntries(new URLSearchParams(await copy.text())),
      })
      return receiver.fetch(request)
    },
  })
  server = await createServer({
    app: {
      url: `http://127.0.0.1:${sink.port}`,
      publicBaseUrl: PUBLIC_BASE,
      authToken: TOKEN,
      accountSid: ACCOUNT,
      callerId: CALLER_ID,
    },
    accounts: { [ACCOUNT]: TOKEN },
  })
})

afterAll(async () => {
  await server.close()
  sink.stop(true)
})

const sdk = (token = TOKEN) =>
  new Twilio(ACCOUNT, token, { httpClient: new MockRequestClient(server.url) })

const admin = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  (await (
    await fetch(`${server.url}/__admin${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  ).json()) as Record<string, unknown>

describe("twilio-node 5.10.0 against the served mock", () => {
  test("verify: verifications.create → code from admin → verificationChecks.create approved", async () => {
    const client = sdk()
    const verification = await client.verify.v2
      .services(VERIFY_SERVICE)
      .verifications.create({ to: PHONE, channel: "sms" })
    expect(verification.sid).toMatch(/^VE[0-9a-f]{32}$/)
    expect(verification.status).toBe("pending")
    expect(verification.accountSid).toBe(ACCOUNT)
    expect(verification.sendCodeAttempts).toHaveLength(1)
    const { code } = (await admin(`/verify/${encodeURIComponent(PHONE)}/latest`)) as {
      code: string
    }
    const wrong = await client.verify.v2.services(VERIFY_SERVICE).verificationChecks.create({
      verificationSid: verification.sid,
      code: code === "000000" ? "111111" : "000000",
    })
    expect(wrong.status).toBe("pending")
    expect(wrong.valid).toBe(false)
    const check = await client.verify.v2
      .services(VERIFY_SERVICE)
      .verificationChecks.create({ to: PHONE, code })
    expect(check.status).toBe("approved")
    expect(check.valid).toBe(true)
    const again = await client.verify.v2
      .services(VERIFY_SERVICE)
      .verificationChecks.create({ verificationSid: verification.sid, code })
      .catch((error: unknown) => error)
    expect(again).toMatchObject({
      status: 404,
      code: 20404,
      moreInfo: "https://www.twilio.com/docs/errors/20404",
    })
  })

  test("lookups.v2.phoneNumbers(...).fetch() maps every field the SDK exposes", async () => {
    const valid = await sdk().lookups.v2.phoneNumbers("+1 (202) 555-0123").fetch()
    expect(valid).toMatchObject({
      callingCountryCode: "1",
      countryCode: "US",
      phoneNumber: PHONE,
      nationalFormat: "(202) 555-0123",
      valid: true,
      validationErrors: [],
      lineTypeIntelligence: null,
    })
    const invalid = await sdk().lookups.v2.phoneNumbers("+15550100").fetch()
    expect(invalid).toMatchObject({
      valid: false,
      validationErrors: ["INVALID_BUT_POSSIBLE"],
      callingCountryCode: null,
    })
    const national = await sdk().lookups.v2.phoneNumbers("02079460123").fetch({ countryCode: "GB" })
    expect(national).toMatchObject({ valid: true, phoneNumber: "+442079460123", countryCode: "GB" })
  })

  test("messages.create returns an SM sid; messages(sid).fetch() reads it back", async () => {
    const client = sdk()
    const message = await client.messages.create({ to: PHONE, from: CALLER_ID, body: "Hello" })
    expect(message.sid).toMatch(/^SM[0-9a-f]{32}$/)
    expect(message.status).toBe("queued")
    expect(message.numSegments).toBe("1")
    expect(message.dateCreated).toBeInstanceOf(Date)
    const fetched = await client.messages(message.sid).fetch()
    expect(fetched.body).toBe("Hello")
    const outbox = (await admin(`/outbox?to=${encodeURIComponent(PHONE)}&kind=sms`))
      .messages as unknown[]
    expect(outbox.length).toBeGreaterThan(0)
  })

  test("a wrong auth token is RestException 401 20003", async () => {
    const error = await sdk("wrong-token")
      .lookups.v2.phoneNumbers(PHONE)
      .fetch()
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ status: 401, code: 20003 })
  })

  test("twilio.validateRequest accepts the mock's inbound SMS signature for the public URL", async () => {
    captured.length = 0
    const result = await admin("/inbound/sms", { from: "+12025550188", body: "Hi there" })
    expect((result.deliveries as { status: number }[])[0]?.status).toBe(200)
    const delivery = captured.find((c) => c.url === "/messaging/inbound/sms")
    expect(delivery?.signature).toBeTruthy()
    expect(
      validateRequest(
        TOKEN,
        delivery?.signature as string,
        `${PUBLIC_BASE}/messaging/inbound/sms`,
        delivery?.params ?? {},
      ),
    ).toBe(true)
    // Against the localhost URL it was posted to, the signature does not verify.
    expect(
      validateRequest(
        TOKEN,
        delivery?.signature as string,
        `http://127.0.0.1:${sink.port}/messaging/inbound/sms`,
        delivery?.params ?? {},
      ),
    ).toBe(false)
    expect(receiver.inbound.some((event) => event.body === "Hi there")).toBe(true)
  })

  test("sms_socket_drop destroys the socket: axios fails and the dispatcher reports an unknown outcome", async () => {
    await admin("/faults", { preset: "sms_socket_drop", count: 1 })
    const channel = new SmsChannel(sdk(), { from: CALLER_ID })
    const delivery = memoryDelivery()
    await expect(
      channel.send(
        { to: PHONE, body: "Reminder", templateId: "appointment.reminder_24h" },
        delivery,
      ),
    ).rejects.toThrow(SMS_DELIVERY_UNKNOWN_OUTCOME_MESSAGE)
    expect(delivery.state?.status).toBe("pending")
  })

  test("a raw WAV upload is served back to the recording adapter over HTTP", async () => {
    const sid = "RE00112233445566778899aabbccddeeff"
    const upload = await fetch(`${server.url}/__admin/recordings/${sid}`, {
      method: "PUT",
      headers: { "content-type": "audio/wav" },
      body: synthesizeWav({ channels: 2, seconds: 0.5 }),
    })
    expect(upload.status).toBe(200)
    const adapter = new TwilioRecordingHttpAdapter({
      accountSid: ACCOUNT,
      authToken: TOKEN,
      apiBaseUrl: server.url,
    })
    const wav = await adapter.download({
      recordingSid: sid,
      recordingUrl: `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Recordings/${sid}`,
    })
    expect(wav.byteLength).toBe(44 + 8000 * 0.5 * 2 * 2)
    const metadata = await sdk().recordings(sid).fetch()
    expect(metadata.channels).toBe(2)
    expect(await sdk().recordings(sid).remove()).toBe(true)
  })

  test("a request carrying the real Twilio Host header is routed without a prefix", async () => {
    const url = new URL(server.url)
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: url.hostname,
          port: url.port,
          path: `/v2/PhoneNumbers/${encodeURIComponent(PHONE)}`,
          headers: {
            host: "lookups.twilio.com",
            authorization: `Basic ${btoa(`${ACCOUNT}:${TOKEN}`)}`,
          },
        },
        (res) => {
          let body = ""
          res.on("data", (chunk) => {
            body += chunk
          })
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
        },
      )
      req.on("error", reject)
      req.end()
    })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ phone_number: PHONE, valid: true })
  })
})
