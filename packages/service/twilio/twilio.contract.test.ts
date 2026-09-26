import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import {
  createRuntime,
  readWav,
  synthesizeWav,
  TWILIO_PRESETS,
  twilioMockUrl,
} from "./src/index.js"
import live from "./test/fixtures/lookups.live.json" with { type: "json" }

const MOCK = "http://twilio.mock"
const ACCOUNT = "AC33333333333333333333333333333333"
const VA = "VA0123456789abcdef0123456789abcdef"
const basic = (user = ACCOUNT, password = "token") => ({
  authorization: `Basic ${btoa(`${user}:${password}`)}`,
})

type Runtime = ReturnType<typeof createRuntime>
const send = (
  runtime: Runtime,
  method: string,
  path: string,
  form?: Record<string, string>,
  headers: Record<string, string> = basic(),
) =>
  runtime.fetch(
    new Request(`${MOCK}${path}`, {
      method,
      headers: {
        ...headers,
        ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    }),
  )
const admin = (
  runtime: Runtime,
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) =>
  runtime.fetch(
    new Request(`${MOCK}/__admin${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )

describe("Lookup v2 answers exactly what the live API recorded", () => {
  for (const entry of live as {
    raw: string
    countryCode?: string
    status: number
    body: unknown
  }[]) {
    test(`${entry.raw}${entry.countryCode ? ` (${entry.countryCode})` : ""}`, async () => {
      const runtime = createRuntime()
      const query = entry.countryCode ? `?CountryCode=${entry.countryCode}` : ""
      const response = await send(
        runtime,
        "GET",
        `/lookups/v2/PhoneNumbers/${encodeURIComponent(entry.raw)}${query}`,
      )
      expect(response.status).toBe(entry.status)
      expect(await response.json()).toEqual(entry.body)
    })
  }
})

describe("the service contract", () => {
  test("/health, the x-mockingbird header and Twilio-shaped 404s", async () => {
    const runtime = createRuntime()
    const health = await runtime.fetch(new Request(`${MOCK}/health`))
    expect(await health.json()).toMatchObject({ status: "ok", service: "twilio" })
    expect(health.headers.get("x-mockingbird")).toMatch(/^twilio@.*; ns=default$/)
    const missing = await send(runtime, "GET", "/api/2010-04-01/Accounts/AC1/Nope.json")
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({
      code: 20404,
      message: "The requested resource /2010-04-01/Accounts/AC1/Nope.json was not found",
      more_info: "https://www.twilio.com/docs/errors/20404",
      status: 404,
    })
  })

  test("Basic auth: missing or non-AC credentials are 401 20003; configured accounts check the token", async () => {
    const open = createRuntime()
    for (const headers of [{}, basic("not-an-account", "x"), basic(ACCOUNT, "")]) {
      const response = await send(
        open,
        "GET",
        "/lookups/v2/PhoneNumbers/+12025550123",
        undefined,
        headers,
      )
      expect(response.status).toBe(401)
      expect(response.headers.get("x-twilio-error-code")).toBe("20003")
      expect(await response.json()).toMatchObject({ code: 20003, status: 401 })
    }
    const strict = createRuntime({ accounts: { [ACCOUNT]: "right" } })
    const wrong = await send(
      strict,
      "GET",
      "/lookups/v2/PhoneNumbers/+12025550123",
      undefined,
      basic(ACCOUNT, "wrong"),
    )
    expect(await wrong.json()).toMatchObject({
      message: `authentication failed, auth token is not valid for account ${ACCOUNT}`,
    })
    const right = await send(
      strict,
      "GET",
      "/lookups/v2/PhoneNumbers/+12025550123",
      undefined,
      basic(ACCOUNT, "right"),
    )
    expect(right.status).toBe(200)
  })

  test("namespaces by header, by /ns/<name> prefix and by AccountSid", async () => {
    const runtime = createRuntime()
    await admin(
      runtime,
      "/credentials",
      { credentials: { AC11111111111111111111111111111111: "by-sid" } },
      "PUT",
    )
    const start = (path: string, headers: Record<string, string>) =>
      send(
        runtime,
        "POST",
        `${path}/verify/v2/Services/${VA}/Verifications`,
        { To: "+12025550123", Channel: "sms" },
        headers,
      )
    await start("", { ...basic(), "x-mockingbird-namespace": "by-header" })
    await start("/ns/by-prefix", basic())
    await start("", basic("AC11111111111111111111111111111111"))
    for (const ns of ["by-header", "by-prefix", "by-sid"]) {
      const latest = await runtime.fetch(
        new Request(`${MOCK}/__admin/verify/+12025550123/latest?namespace=${ns}`),
      )
      expect(latest.status).toBe(200)
    }
    const fallback = await runtime.fetch(new Request(`${MOCK}/__admin/verify/+12025550123/latest`))
    expect(fallback.status).toBe(404)
  })

  test("each catalog preset produces its failure", async () => {
    const runtime = createRuntime()
    runtime.applyPreset("lookup_5xx", "default", { count: 1 })
    const lookup = await send(runtime, "GET", "/lookups/v2/PhoneNumbers/+12025550123")
    expect(lookup.status).toBe(503)
    expect(await lookup.json()).toMatchObject({ code: 20503, status: 503 })
    runtime.applyPreset("verify_5xx", "default", { count: 1 })
    const verify = await send(runtime, "POST", `/verify/v2/Services/${VA}/Verifications`, {
      To: "+12025550123",
      Channel: "sms",
    })
    expect(verify.status).toBe(500)
    runtime.applyPreset("sms_4xx", "default", { count: 1 })
    const messages = `/api/2010-04-01/Accounts/${ACCOUNT}/Messages.json`
    const rejected = await send(runtime, "POST", messages, {
      To: "+12025550123",
      From: "+15005550006",
      Body: "x",
    })
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toMatchObject({ code: 21211 })
    runtime.applyPreset("sms_socket_drop", "default", { count: 1 })
    const dropped = await send(runtime, "POST", messages, {
      To: "+12025550123",
      From: "+15005550006",
      Body: "x",
    }).catch((error: Error) => error)
    // What an in-process fetch sees when the socket dies: a TypeError.
    expect(dropped).toBeInstanceOf(TypeError)
    // Every preset the catalog names, plus the webhook delivery faults.
    expect(Object.keys(TWILIO_PRESETS).sort()).toEqual(
      [
        "lookup_5xx",
        "sms_4xx",
        "sms_socket_drop",
        "verify_5xx",
        "webhook_drop",
        "webhook_duplicate",
      ].sort(),
    )
  })

  test("inbound webhooks are signed HMAC-SHA1(publicUrl + sorted k+v) with the auth token (node:crypto)", async () => {
    const posted: { url: string; signature: string; body: string }[] = []
    const runtime = createRuntime({
      app: {
        url: "http://127.0.0.1:3000",
        publicBaseUrl: "https://public.example",
        authToken: "secret-token",
        callerId: "+13105550100",
      },
      fetch: async (request) => {
        posted.push({
          url: request.url,
          signature: request.headers.get("x-twilio-signature") ?? "",
          body: await request.text(),
        })
        return new Response("<Response/>")
      },
    })
    await runtime.inboundSms({ from: "+12025550188", body: "hi" })
    const [delivery] = posted
    expect(delivery?.url).toBe("http://127.0.0.1:3000/messaging/inbound/sms")
    const params = Object.fromEntries(new URLSearchParams(delivery?.body ?? ""))
    const payload =
      "https://public.example/messaging/inbound/sms" +
      Object.keys(params)
        .sort()
        .map((key) => `${key}${params[key]}`)
        .join("")
    expect(delivery?.signature).toBe(
      createHmac("sha1", "secret-token").update(payload).digest("base64"),
    )
    expect(params).toMatchObject({
      From: "+12025550188",
      To: "+13105550100",
      Body: "hi",
      NumMedia: "0",
    })
  })

  test("the journal records operations and ids, never message text or codes", async () => {
    const runtime = createRuntime({ verify: { fixedCode: "424242" } })
    await send(runtime, "POST", `/verify/v2/Services/${VA}/Verifications`, {
      To: "+12025550123",
      Channel: "sms",
    })
    await send(runtime, "POST", `/verify/v2/Services/${VA}/VerificationCheck`, {
      To: "+12025550123",
      Code: "424242",
    })
    await send(runtime, "POST", `/api/2010-04-01/Accounts/${ACCOUNT}/Messages.json`, {
      To: "+12025550123",
      From: "+15005550006",
      Body: "Top secret lab result",
    })
    const journal = await (await admin(runtime, "/requests")).text()
    expect(journal).toContain("CreateVerificationCheck")
    expect(journal).toContain("CreateMessage")
    expect(journal).not.toContain("424242")
    expect(journal).not.toContain("Top secret")
  })

  test("recordings: RequestedChannels=2 serves both channels, anything else mixes down to mono", async () => {
    const runtime = createRuntime()
    const sid = "RE0123456789abcdef0123456789abcdef"
    await admin(runtime, `/recordings/${sid}`, { seconds: 0.5 }, "PUT")
    const path = `/api/2010-04-01/Accounts/${ACCOUNT}/Recordings/${sid}`
    const stereo = new Uint8Array(
      await (await send(runtime, "GET", `${path}.wav?RequestedChannels=2`)).arrayBuffer(),
    )
    const mono = new Uint8Array(await (await send(runtime, "GET", `${path}.wav`)).arrayBuffer())
    expect(readWav(stereo)?.channels).toBe(2)
    expect(readWav(mono)?.channels).toBe(1)
    expect(mono.byteLength - 44).toBe((stereo.byteLength - 44) / 2)
    const bad = await admin(runtime, `/recordings/${sid}`, { wavBase64: btoa("not a wav") }, "PUT")
    expect(bad.status).toBe(400)
    expect(readWav(synthesizeWav({ channels: 1 }))?.channels).toBe(1)
  })

  test("admin validation errors use the mockingbird_admin shape", async () => {
    const runtime = createRuntime()
    const response = await admin(runtime, "/verify", { fixedCode: "12" }, "PUT")
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { type: "mockingbird_admin" } })
  })

  test("twilioMockUrl rewrites every product host (and edge/region hosts), and nothing else", () => {
    const base = "http://127.0.0.1:8798"
    expect(twilioMockUrl("https://verify.twilio.com/v2/Services/VA1/Verifications", base)).toBe(
      `${base}/verify/v2/Services/VA1/Verifications`,
    )
    expect(twilioMockUrl("https://lookups.twilio.com/v2/PhoneNumbers/+1?Fields=x", base)).toBe(
      `${base}/lookups/v2/PhoneNumbers/+1?Fields=x`,
    )
    expect(
      twilioMockUrl("https://api.sydney.au1.twilio.com/2010-04-01/Accounts.json", `${base}/ns/w1/`),
    ).toBe(`${base}/ns/w1/api/2010-04-01/Accounts.json`)
    expect(twilioMockUrl("https://example.com/x", base)).toBe("https://example.com/x")
  })

  test("a request addressed to the real host is routed by its Host", async () => {
    const runtime = createRuntime()
    const response = await runtime.fetch(
      new Request("https://lookups.twilio.com/v2/PhoneNumbers/+12025550123", { headers: basic() }),
    )
    expect(response.status).toBe(200)
    const health = await runtime.fetch(new Request("https://api.twilio.com/health"))
    expect(health.status).toBe(200)
  })
})
