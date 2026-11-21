import { describe, expect, test } from "bun:test"
import {
  createSandboxProxy,
  SANDBOX_KEY_HEADER,
  type SandboxEnv,
  type SandboxProxyOptions,
  safeEqual,
  sandboxProviders,
  sandboxProxyWorker,
} from "./src/sandbox-proxy.js"

const ACCESS = "access-key-fixture-0123456789"
const STRIPE_KEY = "sk_test_stripe-secret-fixture-abcdef"
const SECRETS: SandboxEnv = {
  SANDBOX_PROXY_TOKEN: ACCESS,
  STRIPE_SECRET_KEY: STRIPE_KEY,
  JUNCTION_API_KEY: "sk_us_junction-secret-fixture",
  RESEND_API_KEY: "re_resend-secret-fixture",
  SLACK_BOT_TOKEN: "xoxb-slack-secret-fixture",
  TWILIO_ACCOUNT_SID: "ACrealsid00000000000000000000000000",
  TWILIO_AUTH_TOKEN: "twilio-token-secret-fixture",
  FCM_ACCESS_TOKEN: "ya29.fcm-secret-fixture",
  FCM_PROJECT_ID: "real-project",
}
const ALL = Object.values(sandboxProviders)

/** A proxy whose outgoing fetch records each request and answers with `answer`. */
const harness = (
  overrides: Partial<SandboxProxyOptions> = {},
  answer: (request: Request) => Response | Promise<Response> = () =>
    Response.json({ ok: true }, { headers: { "x-vendor": "yes" } }),
) => {
  const sent: Request[] = []
  const proxy = createSandboxProxy({
    providers: ALL,
    env: SECRETS,
    fetch: async (request) => {
      sent.push(request)
      return answer(request)
    },
    ...overrides,
  })
  return { proxy, sent }
}

const call = (path: string, init: RequestInit & { key?: string | null } = {}) => {
  const { key = ACCESS, ...rest } = init
  const headers = new Headers(rest.headers)
  if (key !== null) headers.set(SANDBOX_KEY_HEADER, key)
  return new Request(`https://lab.example${path}`, { ...rest, headers })
}

const everySecret = Object.entries(SECRETS)
  .filter(([name]) => name !== "FCM_PROJECT_ID" && name !== "TWILIO_ACCOUNT_SID")
  .map(([, value]) => value as string)
const expectNoSecrets = (text: string) => {
  for (const secret of everySecret) expect(text).not.toContain(secret)
}

describe("manifest", () => {
  test("granted lists each provider's configuration without secret values", async () => {
    const { proxy } = harness({
      env: { ...SECRETS, RESEND_API_KEY: undefined, STRIPE_SECRET_KEY: "sk_live_nope-live-key" },
    })
    const response = await proxy(call("/"))
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const text = await response.text()
    expectNoSecrets(text)
    expect(text).not.toContain("sk_live_nope-live-key")
    const manifest = JSON.parse(text)
    expect(manifest.access).toBe("granted")
    const byId = Object.fromEntries(
      manifest.providers.map((provider: { id: string }) => [provider.id, provider]),
    )
    expect(byId.resend).toEqual({
      id: "resend",
      label: "Resend",
      configured: false,
      missing: ["RESEND_API_KEY"],
    })
    expect(byId.stripe.configured).toBe(false)
    expect(byId.stripe.missing).toEqual([])
    expect(byId.stripe.error).toContain("sandbox mode refuses live keys")
    expect(byId.junction).toEqual({
      id: "junction",
      label: "Junction",
      configured: true,
      missing: [],
    })
    expect(Object.keys(byId).sort()).toEqual(
      ["fcm", "junction", "resend", "slack", "stripe", "twilio"].sort(),
    )
  })

  test("denied when the key is missing or wrong, and configuration stays hidden", async () => {
    const { proxy } = harness()
    for (const key of [null, "wrong", `${ACCESS}x`, ACCESS.slice(0, -1)]) {
      const manifest = await (await proxy(call("/", { key }))).json()
      expect(manifest.access).toBe("denied")
      for (const provider of manifest.providers) {
        expect(provider.configured).toBe(false)
        expect(provider.missing).toEqual([])
      }
    }
  })

  test("disabled when the access-key env var is unset; a custom name is honoured", async () => {
    const { proxy } = harness({ env: { ...SECRETS, SANDBOX_PROXY_TOKEN: undefined } })
    expect((await (await proxy(call("/"))).json()).access).toBe("disabled")
    const custom = harness({ accessKey: "LAB_KEY", env: { ...SECRETS, LAB_KEY: "other" } })
    expect((await (await custom.proxy(call("/"))).json()).access).toBe("denied")
    expect((await (await custom.proxy(call("/", { key: "other" }))).json()).access).toBe("granted")
  })

  test("env is read per request when given as a function", async () => {
    let token: string | undefined
    const { proxy } = harness({ env: () => ({ ...SECRETS, SANDBOX_PROXY_TOKEN: token }) })
    expect((await (await proxy(call("/"))).json()).access).toBe("disabled")
    token = ACCESS
    expect((await (await proxy(call("/"))).json()).access).toBe("granted")
  })

  test("only GET reads the manifest", async () => {
    const { proxy } = harness()
    expect((await proxy(call("/", { method: "POST", body: "{}" }))).status).toBe(405)
  })
})

describe("access", () => {
  test("constant-time comparison is exact", () => {
    expect(safeEqual("abc", "abc")).toBe(true)
    expect(safeEqual("abc", "abd")).toBe(false)
    expect(safeEqual("abc", "abcd")).toBe(false)
    expect(safeEqual("", "")).toBe(true)
    expect(safeEqual("é", "e")).toBe(false)
  })

  test("relays fail closed: 503 without the token, 401 with a wrong key; nothing is sent", async () => {
    const disabled = harness({ env: { ...SECRETS, SANDBOX_PROXY_TOKEN: "" } })
    const off = await disabled.proxy(call("/stripe/v1/customers"))
    expect(off.status).toBe(503)
    expect((await off.json()).error.code).toBe("sandbox_disabled")
    const { proxy, sent } = harness()
    const denied = await proxy(call("/stripe/v1/customers", { key: "nope" }))
    expect(denied.status).toBe(401)
    expect((await denied.json()).error.code).toBe("access_denied")
    expect((await proxy(call("/stripe/v1/customers", { key: null }))).status).toBe(401)
    expect(disabled.sent).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })
})

describe("relay refusals", () => {
  test("unknown provider 404, and a provider not passed to the proxy is unknown", async () => {
    const { proxy } = harness({ providers: [sandboxProviders.stripe] })
    const response = await proxy(call("/nope/v1/x"))
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe("unknown_provider")
    expect((await proxy(call("/resend/emails"))).status).toBe(404)
  })

  test("missing secret answers 503 naming the env var", async () => {
    const { proxy, sent } = harness({ env: { ...SECRETS, TWILIO_AUTH_TOKEN: undefined } })
    const response = await proxy(call("/twilio/2010-04-01/Accounts/ACx/Messages.json"))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: { code: "not_configured", message: "Missing TWILIO_AUTH_TOKEN on the proxy" },
    })
    expect(sent).toHaveLength(0)
  })

  test("Stripe refuses live keys and accepts test and restricted test keys", async () => {
    for (const key of ["sk_live_abcdefgh", "rk_live_abcdefgh", "pk_test_abcdefgh"]) {
      const { proxy, sent } = harness({ env: { ...SECRETS, STRIPE_SECRET_KEY: key } })
      const response = await proxy(call("/stripe/v1/customers"))
      expect(response.status).toBe(503)
      const text = await response.text()
      expect(text).not.toContain(key)
      expect(JSON.parse(text).error.code).toBe("refused_credential")
      expect(sent).toHaveLength(0)
    }
    for (const key of ["sk_test_abcdefgh", "rk_test_abcdefgh"]) {
      const { proxy, sent } = harness({ env: { ...SECRETS, STRIPE_SECRET_KEY: key } })
      expect((await proxy(call("/stripe/v1/customers"))).status).toBe(200)
      expect(sent[0]?.headers.get("authorization")).toBe(`Bearer ${key}`)
    }
  })

  test("Junction accepts sk_us_ / sk_eu_ sandbox keys and refuses anything else", async () => {
    const { proxy: bad } = harness({ env: { ...SECRETS, JUNCTION_API_KEY: "pk_us_production" } })
    expect((await bad(call("/junction/v2/providers"))).status).toBe(503)
    const us = harness()
    expect((await us.proxy(call("/junction/v2/providers?source_type=lab"))).status).toBe(200)
    expect(us.sent[0]?.url).toBe("https://api.sandbox.tryvital.io/v2/providers?source_type=lab")
    expect(us.sent[0]?.headers.get("x-vital-api-key")).toBe(SECRETS.JUNCTION_API_KEY ?? "")
    const eu = harness({ env: { ...SECRETS, JUNCTION_API_KEY: "sk_eu_eu-fixture" } })
    await eu.proxy(call("/junction/v3/order/abc"))
    expect(eu.sent[0]?.url).toBe("https://api.sandbox.eu.tryvital.io/v3/order/abc")
  })

  test("a path the target refuses answers 501 without reaching the vendor", async () => {
    const { proxy, sent } = harness()
    for (const path of [
      "/stripe/c/pay/cs_test",
      "/stripe/",
      "/slack/oauth/v2/authorize",
      "/twilio/v1/Unknown",
      "/fcm/v1/projects/p/messages",
      "/junction/docs",
    ]) {
      const response = await proxy(call(path))
      expect(response.status).toBe(501)
      expect((await response.json()).error.code).toBe("unsupported_operation")
    }
    expect(sent).toHaveLength(0)
  })

  test("a fetch failure answers 502 without echoing secrets", async () => {
    const { proxy } = harness({}, () => {
      throw new Error(`connect failed with ${STRIPE_KEY}`)
    })
    const response = await proxy(call("/stripe/v1/customers"))
    expect(response.status).toBe(502)
    const text = await response.text()
    expectNoSecrets(text)
    expect(JSON.parse(text).error.code).toBe("upstream_unreachable")
  })

  test("paths outside basePath 404; the manifest and relays live under it", async () => {
    const { proxy, sent } = harness({ basePath: "/__sandbox/" })
    expect((await proxy(call("/"))).status).toBe(404)
    expect((await proxy(call("/__sandboxed/stripe/v1/x"))).status).toBe(404)
    expect((await (await proxy(call("/__sandbox"))).json()).access).toBe("granted")
    expect((await (await proxy(call("/__sandbox/"))).json()).access).toBe("granted")
    expect((await proxy(call("/__sandbox/stripe/v1/customers"))).status).toBe(200)
    expect(sent[0]?.url).toBe("https://api.stripe.com/v1/customers")
  })

  test("a crafted path never changes the vendor host", async () => {
    const { proxy, sent } = harness()
    await proxy(call("/resend//evil.example/emails"))
    await proxy(call("/resend/emails/../../x"))
    for (const request of sent) expect(new URL(request.url).host).toBe("api.resend.com")
  })
})

describe("relay", () => {
  test("method, body, query and safe headers go through; unsafe headers are stripped both ways", async () => {
    const { proxy, sent } = harness({}, async () => {
      const headers = new Headers({
        "content-type": "application/json",
        "request-id": "req_123",
        "content-encoding": "gzip",
      })
      headers.append("set-cookie", "session=vendor")
      return new Response(JSON.stringify({ id: "cus_1" }), { status: 201, headers })
    })
    const response = await proxy(
      call("/stripe/v1/customers?expand[]=x&limit=3", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "stripe-version": "2024-06-20",
          "idempotency-key": "idem-1",
          authorization: "Bearer sk_test_fake_from_browser",
          cookie: "lab=1",
          host: "lab.example",
          origin: "https://lab.example",
          referer: "https://lab.example/app",
          "x-mockingbird-namespace": "default",
          "x-mockingbird-admin-key": "admin",
          "cf-connecting-ip": "1.2.3.4",
          "x-forwarded-for": "1.2.3.4",
          forwarded: "for=1.2.3.4",
        },
        body: "email=a%40b.test&name=Ada",
      }),
    )
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ id: "cus_1" })
    expect(response.headers.get("request-id")).toBe("req_123")
    expect(response.headers.has("set-cookie")).toBe(false)
    expect(response.headers.has("content-encoding")).toBe(false)
    const outgoing = sent[0]
    if (!outgoing) throw new Error("nothing relayed")
    expect(outgoing.method).toBe("POST")
    expect(outgoing.redirect).toBe("manual")
    expect(outgoing.url).toBe("https://api.stripe.com/v1/customers?expand[]=x&limit=3")
    expect(await outgoing.text()).toBe("email=a%40b.test&name=Ada")
    expect(outgoing.headers.get("authorization")).toBe(`Bearer ${STRIPE_KEY}`)
    expect(outgoing.headers.get("stripe-version")).toBe("2024-06-20")
    expect(outgoing.headers.get("idempotency-key")).toBe("idem-1")
    expect(outgoing.headers.get("content-type")).toBe("application/x-www-form-urlencoded")
    for (const name of [
      "cookie",
      "origin",
      "referer",
      "x-mockingbird-namespace",
      "x-mockingbird-admin-key",
      SANDBOX_KEY_HEADER,
      "cf-connecting-ip",
      "x-forwarded-for",
      "forwarded",
    ])
      expect(outgoing.headers.has(name)).toBe(false)
    expect(outgoing.headers.get("host")).not.toBe("lab.example")
  })

  test("GET, DELETE and redirects relay as-is", async () => {
    const { proxy, sent } = harness({}, (request) =>
      request.method === "DELETE"
        ? Response.json({ deleted: true })
        : new Response(null, { status: 302, headers: { location: "https://slack.com/x" } }),
    )
    const redirect = await proxy(call("/slack/api/conversations.list?limit=2"))
    expect(redirect.status).toBe(302)
    expect(redirect.headers.get("location")).toBe("https://slack.com/x")
    expect(sent[0]?.url).toBe("https://slack.com/api/conversations.list?limit=2")
    expect(sent[0]?.headers.get("authorization")).toBe(`Bearer ${SECRETS.SLACK_BOT_TOKEN}`)
    const deleted = await proxy(call("/resend/domains/d_1", { method: "DELETE" }))
    expect(await deleted.json()).toEqual({ deleted: true })
    expect(sent[1]?.method).toBe("DELETE")
    expect(sent[1]?.url).toBe("https://api.resend.com/domains/d_1")
  })

  test("a vendor response that echoes a credential is redacted; identifiers are kept", async () => {
    const { proxy } = harness({}, () =>
      Response.json({
        echoed: SECRETS.TWILIO_AUTH_TOKEN,
        account_sid: SECRETS.TWILIO_ACCOUNT_SID,
      }),
    )
    const response = await proxy(
      call("/twilio/2010-04-01/Accounts/ACfake/Messages.json", { method: "POST", body: "To=1" }),
    )
    const text = await response.text()
    expectNoSecrets(text)
    expect(JSON.parse(text).account_sid).toBe(SECRETS.TWILIO_ACCOUNT_SID)
  })

  test("binary bodies stream back untouched", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255])
    const { proxy } = harness(
      {},
      () => new Response(bytes, { headers: { "content-type": "image/png" } }),
    )
    const response = await proxy(call("/twilio/2010-04-01/Accounts/ACx/Media/ME1"))
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  })
})

describe("provider routing", () => {
  test("Twilio picks the host by path, rewrites any account SID and uses Basic auth", async () => {
    const { proxy, sent } = harness()
    const sid = SECRETS.TWILIO_ACCOUNT_SID ?? ""
    const cases: [string, string][] = [
      [
        "/2010-04-01/Accounts/ACfakefake/Messages.json?PageSize=1",
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json?PageSize=1`,
      ],
      [
        "/2010-04-01/Accounts/ACfake.json",
        `https://api.twilio.com/2010-04-01/Accounts/${sid}.json`,
      ],
      ["/v2/Services/VA1/Verifications", "https://verify.twilio.com/v2/Services/VA1/Verifications"],
      ["/v2/Attempts", "https://verify.twilio.com/v2/Attempts"],
      ["/v2/Forms/form-push", "https://verify.twilio.com/v2/Forms/form-push"],
      ["/v2/SafeList/Numbers", "https://verify.twilio.com/v2/SafeList/Numbers"],
      ["/v2/PhoneNumbers/+15005550006", "https://lookups.twilio.com/v2/PhoneNumbers/+15005550006"],
      ["/v1/PhoneNumbers/+15005550006", "https://lookups.twilio.com/v1/PhoneNumbers/+15005550006"],
      ["/v1/Services/MG1", "https://messaging.twilio.com/v1/Services/MG1"],
    ]
    for (const [path] of cases) expect((await proxy(call(`/twilio${path}`))).status).toBe(200)
    expect(sent.map((request) => request.url)).toEqual(cases.map(([, url]) => url))
    expect(sent[0]?.headers.get("authorization")).toBe(
      `Basic ${btoa(`${sid}:${SECRETS.TWILIO_AUTH_TOKEN}`)}`,
    )
  })

  test("Twilio keeps the body through the SID rewrite", async () => {
    const { proxy, sent } = harness()
    await proxy(
      call("/twilio/2010-04-01/Accounts/ACfake/Messages.json", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "To=%2B15005550006&Body=hi",
      }),
    )
    expect(await sent[0]?.text()).toBe("To=%2B15005550006&Body=hi")
  })

  test("FCM rewrites the project, sends the bearer token and only relays POST messages:send", async () => {
    const { proxy, sent } = harness()
    const ok = await proxy(
      call("/fcm/v1/projects/demo-project/messages:send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: { token: "t" } }),
      }),
    )
    expect(ok.status).toBe(200)
    expect(sent[0]?.url).toBe("https://fcm.googleapis.com/v1/projects/real-project/messages:send")
    expect(sent[0]?.headers.get("authorization")).toBe(`Bearer ${SECRETS.FCM_ACCESS_TOKEN}`)
    expect(await sent[0]?.json()).toEqual({ message: { token: "t" } })
    expect((await proxy(call("/fcm/v1/projects/demo-project/messages:send"))).status).toBe(501)
    expect((await proxy(call("/fcm/v1/projects/p/topics:x", { method: "POST" }))).status).toBe(501)
    expect(sent).toHaveLength(1)
  })

  test("Resend and Slack attach bearer tokens", async () => {
    const { proxy, sent } = harness()
    await proxy(call("/resend/emails", { method: "POST", body: "{}" }))
    await proxy(call("/slack/api/chat.postMessage", { method: "POST", body: "{}" }))
    expect(sent[0]?.url).toBe("https://api.resend.com/emails")
    expect(sent[0]?.headers.get("authorization")).toBe(`Bearer ${SECRETS.RESEND_API_KEY}`)
    expect(sent[1]?.url).toBe("https://slack.com/api/chat.postMessage")
    expect(sent[1]?.headers.get("authorization")).toBe(`Bearer ${SECRETS.SLACK_BOT_TOKEN}`)
  })
})

describe("CORS", () => {
  const allowOrigins = ["https://app.example", /^https:\/\/pr-\d+\.preview\.example$/]

  test("preflight answers allowed origins only, never allowing authorization or cookies", async () => {
    const { proxy } = harness({ allowOrigins })
    const preflight = (origin: string) =>
      proxy(
        new Request("https://proxy.example/stripe/v1/customers", {
          method: "OPTIONS",
          headers: {
            origin,
            "access-control-request-method": "POST",
            "access-control-request-headers": `content-type, stripe-version, authorization, cookie, ${SANDBOX_KEY_HEADER}`,
          },
        }),
      )
    for (const origin of ["https://app.example", "https://pr-12.preview.example"]) {
      const response = await preflight(origin)
      expect(response.status).toBe(204)
      expect(response.headers.get("access-control-allow-origin")).toBe(origin)
      const allowed = (response.headers.get("access-control-allow-headers") ?? "").split(", ")
      expect(allowed).toContain(SANDBOX_KEY_HEADER)
      expect(allowed).toContain("content-type")
      expect(allowed).toContain("stripe-version")
      expect(allowed).not.toContain("authorization")
      expect(allowed).not.toContain("cookie")
      expect(response.headers.get("access-control-allow-methods")).toContain("POST")
    }
    const evil = await preflight("https://evil.example")
    expect(evil.status).toBe(204)
    expect(evil.headers.has("access-control-allow-origin")).toBe(false)
  })

  test("responses carry allow-origin and expose vendor headers only for allowed origins", async () => {
    const { proxy } = harness({ allowOrigins })
    const allowed = await proxy(
      call("/stripe/v1/customers", { headers: { origin: "https://app.example" } }),
    )
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.example")
    expect(allowed.headers.get("access-control-expose-headers")).toContain("x-vendor")
    expect(allowed.headers.get("vary")).toContain("Origin")
    const denied = await proxy(
      call("/stripe/v1/customers", { headers: { origin: "https://evil.example" } }),
    )
    expect(denied.headers.has("access-control-allow-origin")).toBe(false)
    const noConfig = harness()
    const sameOrigin = await noConfig.proxy(
      call("/", { headers: { origin: "https://app.example" } }),
    )
    expect(sameOrigin.headers.has("access-control-allow-origin")).toBe(false)
  })
})

test("no response body ever contains a secret", async () => {
  const echo = (request: Request) =>
    Response.json({ authorization: request.headers.get("authorization"), url: request.url })
  const { proxy } = harness({}, echo)
  const paths = [
    "/",
    "/stripe/v1/customers",
    "/junction/v2/providers",
    "/resend/emails",
    "/slack/api/auth.test",
    "/twilio/2010-04-01/Accounts/ACx/Messages.json",
    "/fcm/v1/projects/p/messages:send",
    "/nope",
    "/stripe/c/pay",
  ]
  for (const path of paths)
    for (const key of [ACCESS, "wrong", null]) {
      const response = await proxy(call(path, { method: path === "/" ? "GET" : "POST", key }))
      expectNoSecrets(await response.text())
    }
})

test("sandboxProxyWorker reads secrets from the Worker env per call", async () => {
  const sent: Request[] = []
  const worker = sandboxProxyWorker({
    providers: [sandboxProviders.stripe],
    basePath: "/__sandbox",
    fetch: async (request) => {
      sent.push(request)
      return Response.json({ ok: true })
    },
  })
  expect((await (await worker.fetch(call("/__sandbox/"), {})).json()).access).toBe("disabled")
  const response = await worker.fetch(call("/__sandbox/stripe/v1/balance"), SECRETS)
  expect(response.status).toBe(200)
  expect(sent[0]?.headers.get("authorization")).toBe(`Bearer ${STRIPE_KEY}`)
})

test("duplicate provider ids are rejected", () => {
  expect(() =>
    createSandboxProxy({ providers: [sandboxProviders.stripe, sandboxProviders.stripe], env: {} }),
  ).toThrow("distinct")
})
