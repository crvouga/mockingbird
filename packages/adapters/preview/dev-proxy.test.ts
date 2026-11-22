import { describe, expect, test } from "bun:test"
import {
  createDevProxy,
  type DevEnv,
  type DevProxyOptions,
  devBaseUrlName,
  devProviders,
  devProxyWorker,
  NON_PROD_PATTERNS,
} from "./src/dev-proxy.js"

const STRIPE_KEY = "sk_test_StripeSecretFixtureAbcdef"
const SECRETS: DevEnv = {
  STRIPE_SECRET_KEY: STRIPE_KEY,
  JUNCTION_API_KEY: "sk_us_junction-secret-fixture",
  RESEND_API_KEY: "re_resend-secret-fixture",
  SLACK_BOT_TOKEN: "xoxb-slack-secret-fixture",
  TWILIO_ACCOUNT_SID: "ACrealsid00000000000000000000000000",
  TWILIO_AUTH_TOKEN: "twilio-token-secret-fixture",
  FCM_ACCESS_TOKEN: "ya29.fcm-secret-fixture",
  FCM_PROJECT_ID: "real-project",
}
const ALL = Object.values(devProviders)

/** What a consumer writes: vendor non-prod formats plus pins for vendors that have none. */
const ALLOW: DevProxyOptions["allow"] = {
  ...NON_PROD_PATTERNS,
  RESEND_API_KEY: /^re_[A-Za-z0-9_-]+$/,
  SLACK_BOT_TOKEN: /^xoxb-[A-Za-z0-9-]+$/,
  TWILIO_ACCOUNT_SID: /^ACrealsid0{26}$/,
  TWILIO_AUTH_TOKEN: /^[a-z-]+$/,
  FCM_ACCESS_TOKEN: /^ya29\.[A-Za-z0-9._-]+$/,
  FCM_PROJECT_ID: /^real-project$/,
}

/** A proxy whose outgoing fetch records each request and answers with `answer`. */
const harness = (
  overrides: Partial<DevProxyOptions> = {},
  answer: (request: Request) => Response | Promise<Response> = () =>
    Response.json({ ok: true }, { headers: { "x-vendor": "yes" } }),
) => {
  const sent: Request[] = []
  const proxy = createDevProxy({
    providers: ALL,
    env: SECRETS,
    allow: ALLOW,
    fetch: async (request) => {
      sent.push(request)
      return answer(request)
    },
    ...overrides,
  })
  return { proxy, sent }
}

/** A request from the lab page itself: `Sec-Fetch-Site: same-origin` unless `site` says otherwise. */
const call = (path: string, init: RequestInit & { site?: string | null } = {}) => {
  const { site = "same-origin", ...rest } = init
  const headers = new Headers(rest.headers)
  if (site !== null) headers.set("sec-fetch-site", site)
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
    expect(Object.keys(manifest)).toEqual(["providers"])
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
    expect(byId.stripe.blocked).toBe("STRIPE_SECRET_KEY is a production credential")
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

  test("env is read per request when given as a function", async () => {
    let key: string | undefined
    const { proxy } = harness({ env: () => ({ ...SECRETS, STRIPE_SECRET_KEY: key }) })
    const stripe = async () =>
      (await (await proxy(call("/"))).json()).providers.find(
        (provider: { id: string }) => provider.id === "stripe",
      )
    expect((await stripe()).configured).toBe(false)
    key = STRIPE_KEY
    expect((await stripe()).configured).toBe(true)
  })

  test("only GET reads the manifest", async () => {
    const { proxy } = harness()
    expect((await proxy(call("/", { method: "POST", body: "{}" }))).status).toBe(405)
  })
})

describe("same-origin trust", () => {
  test("a same-origin browser request is accepted, with or without an Origin header", async () => {
    const { proxy, sent } = harness()
    expect((await proxy(call("/stripe/v1/customers"))).status).toBe(200)
    const withOrigin = call("/stripe/v1/customers", {
      method: "POST",
      headers: { origin: "https://lab.example" },
      body: "a=1",
    })
    expect((await proxy(withOrigin)).status).toBe(200)
    expect((await proxy(call("/"))).status).toBe(200)
    expect(sent).toHaveLength(2)
  })

  test("cross-site, same-site and navigation requests are refused with 403 and nothing is sent", async () => {
    const { proxy, sent } = harness()
    for (const site of ["cross-site", "same-site", "none"])
      for (const path of ["/", "/stripe/v1/customers"]) {
        const response = await proxy(call(path, { site }))
        expect(response.status).toBe(403)
        expect((await response.json()).error.code).toBe("cross_origin")
      }
    expect(sent).toHaveLength(0)
  })

  test("a foreign Origin is refused even when Sec-Fetch-Site claims same-origin", async () => {
    const { proxy, sent } = harness()
    for (const origin of ["https://evil.example", "http://lab.example", "null"]) {
      const response = await proxy(call("/stripe/v1/customers", { headers: { origin } }))
      expect(response.status).toBe(403)
      expect((await response.json()).error.code).toBe("cross_origin")
    }
    expect(sent).toHaveLength(0)
  })

  test("a request without Sec-Fetch-Site is refused unless trustNonBrowser is set", async () => {
    const strict = harness()
    const refused = await strict.proxy(call("/stripe/v1/customers", { site: null }))
    expect(refused.status).toBe(403)
    expect((await refused.json()).error.code).toBe("cross_origin")
    expect(strict.sent).toHaveLength(0)
    const trusting = harness({ trustNonBrowser: true })
    expect((await trusting.proxy(call("/stripe/v1/customers", { site: null }))).status).toBe(200)
    // trustNonBrowser never admits a browser request from elsewhere.
    expect(
      (await trusting.proxy(call("/stripe/v1/customers", { site: "cross-site" }))).status,
    ).toBe(403)
    const foreign = call("/stripe/v1/customers", {
      site: null,
      headers: { origin: "https://evil.example" },
    })
    expect((await trusting.proxy(foreign)).status).toBe(403)
    expect(trusting.sent).toHaveLength(1)
  })

  test("an allowOrigins page is trusted from another origin", async () => {
    const { proxy, sent } = harness({ allowOrigins: ["https://app.example"] })
    const response = await proxy(
      call("/stripe/v1/customers", {
        site: "cross-site",
        headers: { origin: "https://app.example" },
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example")
    expect(sent).toHaveLength(1)
  })
})

describe("relay refusals", () => {
  test("unknown provider 404, and a provider not passed to the proxy is unknown", async () => {
    const { proxy } = harness({ providers: [devProviders.stripe] })
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
      expect(response.status).toBe(403)
      const text = await response.text()
      expect(text).not.toContain(key)
      expect(JSON.parse(text).error.code).toBe("not_allowed")
      expect(sent).toHaveLength(0)
    }
    for (const key of ["sk_test_abcdefgh", "rk_test_abcdefgh"]) {
      const { proxy, sent } = harness({ env: { ...SECRETS, STRIPE_SECRET_KEY: key } })
      expect((await proxy(call("/stripe/v1/customers"))).status).toBe(200)
      expect(sent[0]?.headers.get("authorization")).toBe(`Bearer ${key}`)
    }
  })

  test("Junction accepts sk_us_ / sk_eu_ keys on its sandbox hosts and refuses anything else", async () => {
    const { proxy: bad } = harness({ env: { ...SECRETS, JUNCTION_API_KEY: "pk_us_production" } })
    expect((await bad(call("/junction/v2/providers"))).status).toBe(403)
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
    const { proxy, sent } = harness({ basePath: "/__dev/" })
    expect((await proxy(call("/"))).status).toBe(404)
    expect((await proxy(call("/__devx/stripe/v1/x"))).status).toBe(404)
    expect((await (await proxy(call("/__dev"))).json()).providers).toHaveLength(ALL.length)
    expect((await (await proxy(call("/__dev/"))).json()).providers).toHaveLength(ALL.length)
    expect((await proxy(call("/__dev/stripe/v1/customers"))).status).toBe(200)
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
      "sec-fetch-site",
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
            "access-control-request-headers": "content-type, stripe-version, authorization, cookie",
          },
        }),
      )
    for (const origin of ["https://app.example", "https://pr-12.preview.example"]) {
      const response = await preflight(origin)
      expect(response.status).toBe(204)
      expect(response.headers.get("access-control-allow-origin")).toBe(origin)
      const allowed = (response.headers.get("access-control-allow-headers") ?? "").split(", ")
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
    for (const site of ["same-origin", "cross-site", null]) {
      const response = await proxy(call(path, { method: path === "/" ? "GET" : "POST", site }))
      expectNoSecrets(await response.text())
    }
})

test("devProxyWorker reads secrets from the Worker env per call", async () => {
  const sent: Request[] = []
  const worker = devProxyWorker({
    providers: [devProviders.stripe],
    allow: NON_PROD_PATTERNS,
    basePath: "/__dev",
    fetch: async (request) => {
      sent.push(request)
      return Response.json({ ok: true })
    },
  })
  const manifest = await (await worker.fetch(call("/__dev/"), {})).json()
  expect(manifest.providers[0]).toMatchObject({ configured: false, missing: ["STRIPE_SECRET_KEY"] })
  const response = await worker.fetch(call("/__dev/stripe/v1/balance"), SECRETS)
  expect(response.status).toBe(200)
  expect(sent[0]?.headers.get("authorization")).toBe(`Bearer ${STRIPE_KEY}`)
})

test("duplicate provider ids are rejected", () => {
  expect(() =>
    createDevProxy({ providers: [devProviders.stripe, devProviders.stripe], env: {}, allow: {} }),
  ).toThrow("distinct")
})

describe("safety model (default deny)", () => {
  const manifestOf = async (proxy: (request: Request) => Promise<Response>) => {
    const manifest = await (await proxy(call("/"))).json()
    return Object.fromEntries(
      manifest.providers.map((provider: { id: string }) => [provider.id, provider]),
    ) as Record<string, { configured: boolean; missing: string[]; blocked?: string }>
  }

  test("a secret without an allow-list entry blocks its provider: manifest reason, 403, nothing sent", async () => {
    const { RESEND_API_KEY: _resend, ...allow } = ALLOW
    const { proxy, sent } = harness({ allow })
    const byId = await manifestOf(proxy)
    expect(byId.resend).toEqual({
      id: "resend",
      label: "Resend",
      configured: false,
      missing: [],
      blocked: "No allow-list pattern for RESEND_API_KEY",
    } as never)
    expect(byId.stripe?.configured).toBe(true)
    const response = await proxy(call("/resend/emails", { method: "POST", body: "{}" }))
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: { code: "not_allowed", message: "No allow-list pattern for RESEND_API_KEY" },
    })
    expect(sent).toHaveLength(0)
  })

  test("an empty allow map blocks every provider", async () => {
    const { proxy, sent } = harness({ allow: {} })
    for (const provider of Object.values(await manifestOf(proxy))) {
      expect(provider.configured).toBe(false)
      expect(provider.blocked).toStartWith("No allow-list pattern for ")
    }
    for (const path of ["/stripe/v1/customers", "/slack/api/auth.test", "/junction/v2/providers"])
      expect((await proxy(call(path))).status).toBe(403)
    expect(sent).toHaveLength(0)
  })

  test("unanchored, multiline or non-RegExp patterns and a missing allow map throw at construction", () => {
    const build = (allow: unknown) => () =>
      createDevProxy({
        providers: [devProviders.stripe],
        env: {},
        allow: allow as DevProxyOptions["allow"],
      })
    for (const pattern of [/sk_test_/, /^sk_test_/, /sk_test_.*$/, /^sk_test_\$/, /^$|x/])
      expect(build({ STRIPE_SECRET_KEY: pattern })).toThrow("anchored")
    expect(build({ STRIPE_SECRET_KEY: /^sk_test_x$/m })).toThrow("m flag")
    expect(build({ STRIPE_SECRET_KEY: "^sk_test_.*$" })).toThrow("RegExp")
    expect(build(undefined)).toThrow("allow")
    expect(() =>
      devProxyWorker({ providers: [devProviders.stripe], allow: { STRIPE_SECRET_KEY: /sk_/ } }),
    ).toThrow("anchored")
    expect(build({ STRIPE_SECRET_KEY: /^sk_test_\\$/ })).not.toThrow()
  })

  test("patterns match the whole value, even with a top-level alternation", async () => {
    const value = "re_bad_value_re_b"
    const { proxy, sent } = harness({
      env: { ...SECRETS, RESEND_API_KEY: value },
      allow: { ...ALLOW, RESEND_API_KEY: /^re_a|re_b$/ },
    })
    expect((await manifestOf(proxy)).resend?.blocked).toBe(
      "RESEND_API_KEY does not match its allow-list pattern",
    )
    expect((await proxy(call("/resend/emails"))).status).toBe(403)
    const stateful = harness({ allow: { ...ALLOW, RESEND_API_KEY: /^re_[a-z-]+$/g } })
    for (let index = 0; index < 3; index++)
      expect((await stateful.proxy(call("/resend/emails"))).status).toBe(200)
    expect(sent).toHaveLength(0)
  })

  test("a production credential is refused even when allow matches", async () => {
    for (const key of ["sk_live_abcdefgh", "rk_live_abcdefgh"]) {
      const { proxy, sent } = harness({
        env: { ...SECRETS, STRIPE_SECRET_KEY: key },
        allow: { ...ALLOW, STRIPE_SECRET_KEY: /^.+$/ },
      })
      expect((await manifestOf(proxy)).stripe?.blocked).toBe(
        "STRIPE_SECRET_KEY is a production credential",
      )
      const response = await proxy(call("/stripe/v1/customers"))
      expect(response.status).toBe(403)
      const text = await response.text()
      expect(text).not.toContain(key)
      expect(JSON.parse(text).error).toEqual({
        code: "not_allowed",
        message: "STRIPE_SECRET_KEY is a production credential",
      })
      expect(sent).toHaveLength(0)
    }
  })

  test("NON_PROD_PATTERNS accept vendor test formats only", () => {
    const stripe = NON_PROD_PATTERNS.STRIPE_SECRET_KEY
    for (const key of ["sk_test_51Abc", "rk_test_51Abc"]) expect(stripe.test(key)).toBe(true)
    for (const key of ["sk_live_51Abc", "pk_test_51Abc", "sk_test_", "xsk_test_1", "sk_test_1\n"])
      expect(stripe.test(key)).toBe(false)
    const junction = NON_PROD_PATTERNS.JUNCTION_API_KEY
    for (const key of ["sk_us_Ab-c_1", "sk_eu_Ab-c_1"]) expect(junction.test(key)).toBe(true)
    for (const key of ["pk_us_prod", "sk_uk_x", "sk_us_"]) expect(junction.test(key)).toBe(false)
  })

  test("identifiers are allow-checked: a Twilio SID or FCM project outside the pin is refused", async () => {
    const twilio = harness({
      env: { ...SECRETS, TWILIO_ACCOUNT_SID: "ACproduction0000000000000000000000" },
    })
    expect((await manifestOf(twilio.proxy)).twilio?.blocked).toBe(
      "TWILIO_ACCOUNT_SID does not match its allow-list pattern",
    )
    const refused = await twilio.proxy(call("/twilio/2010-04-01/Accounts/ACx/Messages.json"))
    expect(refused.status).toBe(403)
    expect(await refused.text()).not.toContain("ACproduction")
    const fcm = harness({ env: { ...SECRETS, FCM_PROJECT_ID: "prod-project" } })
    expect(
      (await fcm.proxy(call("/fcm/v1/projects/p/messages:send", { method: "POST", body: "{}" })))
        .status,
    ).toBe(403)
    expect(twilio.sent).toHaveLength(0)
    expect(fcm.sent).toHaveLength(0)
  })

  test("<ID>_BASE_URL overrides the default host only when allow-listed", async () => {
    expect(devBaseUrlName("resend")).toBe("RESEND_BASE_URL")
    expect(devBaseUrlName("my-service")).toBe("MY_SERVICE_BASE_URL")
    const base = "https://resend.dev.example/api/"
    const allowed = harness({
      env: { ...SECRETS, RESEND_BASE_URL: base },
      allow: { ...ALLOW, RESEND_BASE_URL: /^https:\/\/resend\.dev\.example\/api\/$/ },
    })
    expect((await manifestOf(allowed.proxy)).resend?.configured).toBe(true)
    expect((await allowed.proxy(call("/resend/emails?x=1"))).status).toBe(200)
    expect(allowed.sent[0]?.url).toBe("https://resend.dev.example/api/emails?x=1")
    expect(allowed.sent[0]?.headers.get("authorization")).toBe(`Bearer ${SECRETS.RESEND_API_KEY}`)

    const refusals: [DevEnv, DevProxyOptions["allow"], string][] = [
      [{ RESEND_BASE_URL: base }, ALLOW, "No allow-list pattern for RESEND_BASE_URL"],
      [
        { RESEND_BASE_URL: "https://api.resend.com.evil.example/" },
        { ...ALLOW, RESEND_BASE_URL: /^https:\/\/resend\.dev\.example\/api\/$/ },
        "RESEND_BASE_URL does not match its allow-list pattern",
      ],
      [
        { RESEND_BASE_URL: "http://resend.dev.example" },
        { ...ALLOW, RESEND_BASE_URL: /^.+$/ },
        "RESEND_BASE_URL must be an https URL without query or credentials",
      ],
      [
        { RESEND_BASE_URL: "https://user:pass@resend.dev.example" },
        { ...ALLOW, RESEND_BASE_URL: /^.+$/ },
        "RESEND_BASE_URL must be an https URL without query or credentials",
      ],
      [
        { RESEND_BASE_URL: "not a url" },
        { ...ALLOW, RESEND_BASE_URL: /^.+$/ },
        "RESEND_BASE_URL must be an https URL without query or credentials",
      ],
    ]
    for (const [env, allow, reason] of refusals) {
      const { proxy, sent } = harness({ env: { ...SECRETS, ...env }, allow })
      expect((await manifestOf(proxy)).resend?.blocked).toBe(reason)
      const response = await proxy(call("/resend/emails"))
      expect(response.status).toBe(403)
      expect((await response.json()).error.message).toBe(reason)
      expect(sent).toHaveLength(0)
    }
  })

  test("a Twilio override replaces only the API host; a Junction override wins over the EU switch", async () => {
    const twilio = harness({
      env: { ...SECRETS, TWILIO_BASE_URL: "https://twilio.dev.example" },
      allow: { ...ALLOW, TWILIO_BASE_URL: /^https:\/\/twilio\.dev\.example$/ },
    })
    await twilio.proxy(call("/twilio/2010-04-01/Accounts/ACx/Messages.json"))
    await twilio.proxy(call("/twilio/v2/Services/VA1/Verifications"))
    expect(twilio.sent.map((request) => request.url)).toEqual([
      `https://twilio.dev.example/2010-04-01/Accounts/${SECRETS.TWILIO_ACCOUNT_SID}/Messages.json`,
      "https://verify.twilio.com/v2/Services/VA1/Verifications",
    ])
    const junction = harness({
      env: {
        ...SECRETS,
        JUNCTION_API_KEY: "sk_eu_eu-fixture",
        JUNCTION_BASE_URL: "https://vital.dev.example",
      },
      allow: { ...ALLOW, JUNCTION_BASE_URL: /^https:\/\/vital\.dev\.example$/ },
    })
    await junction.proxy(call("/junction/v3/order/abc"))
    expect(junction.sent[0]?.url).toBe("https://vital.dev.example/v3/order/abc")
  })

  test("the manifest never contains a secret value, in any configuration", async () => {
    const cases: [DevEnv, DevProxyOptions["allow"]][] = [
      [SECRETS, ALLOW],
      [SECRETS, {}],
      [{ ...SECRETS, STRIPE_SECRET_KEY: "sk_live_LiveKeyFixture" }, ALLOW],
      [
        { ...SECRETS, STRIPE_SECRET_KEY: "sk_live_LiveKeyFixture" },
        { ...ALLOW, STRIPE_SECRET_KEY: /^.+$/ },
      ],
      [{ ...SECRETS, STRIPE_SECRET_KEY: "pk_test_PublishableFixture" }, ALLOW],
      [{ ...SECRETS, TWILIO_ACCOUNT_SID: "ACproduction0000000000000000000000" }, ALLOW],
      [{ ...SECRETS, FCM_PROJECT_ID: "prod-project" }, ALLOW],
      [{ ...SECRETS, RESEND_BASE_URL: "https://resend.dev.example" }, ALLOW],
      [
        { ...SECRETS, RESEND_BASE_URL: "http://resend.dev.example" },
        { ...ALLOW, RESEND_BASE_URL: /^.+$/ },
      ],
      [{ ...SECRETS, RESEND_API_KEY: undefined, TWILIO_AUTH_TOKEN: "" }, ALLOW],
    ]
    for (const [env, allow] of cases) {
      const { proxy } = harness({ env, allow })
      const values = Object.values(env).filter((value): value is string => Boolean(value))
      for (const site of ["same-origin", "cross-site", null]) {
        const text = await (await proxy(call("/", { site }))).text()
        for (const value of values) expect(text).not.toContain(value)
      }
    }
  })
})
