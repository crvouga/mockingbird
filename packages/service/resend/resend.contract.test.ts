import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { createRuntime, RESEND_PRESETS, type ResendRuntimeOptions } from "./src/index.js"
import { createServer, serveTarget } from "./src/server.js"

const API = "http://resend.mock"
const SECRET = `whsec_${Buffer.from("contract-test-secret-0123456789").toString("base64")}`
const COMMON = { adminKey: undefined, seed: undefined, onLog: undefined }

const harness = (options: ResendRuntimeOptions = {}) => {
  const deliveries: { headers: Headers; body: string }[] = []
  const runtime = createRuntime({
    webhooks: {
      url: "http://backend.local/messaging/inbound/email",
      secret: SECRET,
      fetch: async (request) => {
        deliveries.push({ headers: request.headers, body: await request.text() })
        return Response.json({ ok: true })
      },
    },
    ...options,
  })
  const call = (
    path: string,
    init: { method?: string; body?: unknown; key?: string; headers?: Record<string, string> } = {},
  ) =>
    runtime.fetch(
      new Request(`${API}${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: {
          "content-type": "application/json",
          ...(init.key === "" ? {} : { authorization: `Bearer ${init.key ?? "re_test"}` }),
          ...init.headers,
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    )
  const send = (
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
    key?: string,
  ) => call("/emails", { body, headers, ...(key ? { key } : {}) })
  return { runtime, call, send, deliveries }
}

const email = (overrides: Record<string, unknown> = {}) => ({
  from: "Geviti <no-reply@gogeviti.com>",
  to: ["member@example.com"],
  subject: "Hello",
  html: '<p><a href="https://app.test/a?x=1&amp;y=2">A</a></p>',
  ...overrides,
})

describe("the service contract", () => {
  test("health, missing key, unknown email, x-mockingbird", async () => {
    const { call } = harness()
    expect((await call("/health", { key: "" })).status).toBe(200)
    const noKey = await call("/emails", { body: email(), key: "" })
    expect(noKey.status).toBe(401)
    expect(((await noKey.json()) as { name: string }).name).toBe("missing_api_key")
    const missing = await call("/emails/00000000-0000-4000-8000-000000000000")
    expect(await missing.json()).toEqual({
      statusCode: 404,
      name: "not_found",
      message: "Email not found",
    })
    expect(missing.headers.get("x-mockingbird")).toMatch(/^resend@.+; ns=default$/)
  })

  test("namespaces by header, by /ns/ prefix and by API key are isolated", async () => {
    const { call, send } = harness()
    await call("/__admin/credentials", {
      method: "PUT",
      body: { credentials: { re_worker_a: "a" } },
    })
    const sent = (await (await send(email(), {}, "re_worker_a")).json()) as { id: string }
    expect((await call(`/emails/${sent.id}`, { key: "re_worker_a" })).status).toBe(200)
    expect((await call(`/emails/${sent.id}`, { key: "re_worker_b" })).status).toBe(404)
    expect(
      (await call(`/emails/${sent.id}`, { headers: { "x-mockingbird-namespace": "a" } })).status,
    ).toBe(200)
    expect((await call(`/ns/a/emails/${sent.id}`)).status).toBe(200)
  })

  test("the journal keeps ids and operations, never subjects or bodies", async () => {
    const { call, send } = harness()
    const sent = (await (
      await send(email({ subject: "Lab results for Jane", text: "PHI glucose 212" }))
    ).json()) as { id: string }
    const journal = await (await call("/__admin/requests")).text()
    expect(journal).toContain("SendEmail")
    expect(journal).toContain(sent.id)
    expect(journal).not.toContain("Jane")
    expect(journal).not.toContain("glucose")
  })

  test("every catalog preset is registered", async () => {
    expect(Object.keys(RESEND_PRESETS)).toEqual(
      expect.arrayContaining(["send_422", "send_429", "send_500", "non_json_500", "network_drop"]),
    )
    const { runtime, send } = harness()
    runtime.applyPreset("network_drop", "default", { count: 1 })
    await expect(send(email())).rejects.toThrow(TypeError)
    runtime.applyPreset("send_429", "default", { count: 1 })
    const limited = await send(email())
    expect(limited.headers.get("retry-after")).toBe("1")
    runtime.applyPreset("non_json_500", "default", { count: 1 })
    const html = await send(email())
    expect(html.headers.get("content-type")).toContain("text/html")
    expect((await send(email())).status).toBe(200)
  })

  test("concurrent requests with one Idempotency-Key: the second is a 409 conflict", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { send } = harness({
      forwardToInbox: {
        url: "http://inbox.local",
        fetch: async () => {
          await gate
          return new Response(null, { status: 201 })
        },
      },
    })
    const first = send(email(), { "Idempotency-Key": "welcome-1" })
    await Bun.sleep(10)
    const second = await send(email(), { "Idempotency-Key": "welcome-1" })
    expect(second.status).toBe(409)
    expect(((await second.json()) as { name: string }).name).toBe("concurrent_idempotent_requests")
    release()
    expect((await first).status).toBe(200)
    const replay = await send(email(), { "Idempotency-Key": "welcome-1" })
    expect(replay.headers.get("idempotent-replayed")).toBe("true")
  })
})

describe("outbox and forwarding", () => {
  test("filters by to, tag and since; links from html, or from text when there is none", async () => {
    const { runtime, call, send } = harness()
    const a = (await (
      await send(
        email({ to: "Ada <ADA@example.com>", tags: [{ name: "category", value: "reset" }] }),
      )
    ).json()) as { id: string }
    runtime.clock.advance(60_000)
    const since = new Date(runtime.clock.now()).toISOString()
    const b = (await (
      await send(
        email({ to: "bob@example.com", html: undefined, text: "Go to https://app.test/b?z=9 now" }),
      )
    ).json()) as { id: string }
    const ids = async (query: string) =>
      (
        (await (await call(`/__admin/outbox${query}`)).json()) as { messages: { id: string }[] }
      ).messages.map((m) => m.id)
    expect(await ids("?to=ada@example.com")).toEqual([a.id])
    expect(await ids("?tag=category:reset")).toEqual([a.id])
    expect(await ids("?tag=category")).toEqual([a.id])
    expect(await ids("?tag=category:other")).toEqual([])
    expect(await ids(`?since=${since}`)).toEqual([b.id])
    const linksOf = async (id: string) =>
      ((await (await call(`/__admin/outbox/${id}/links`)).json()) as { links: string[] }).links
    expect(await linksOf(a.id)).toEqual(["https://app.test/a?x=1&y=2"])
    expect(await linksOf(b.id)).toEqual(["https://app.test/b?z=9"])
    expect((await call("/__admin/outbox/nope/links")).status).toBe(404)
  })

  test("a failing inbox never fails the send; /__admin/forwarding counts it", async () => {
    const { runtime, call, send } = harness({
      forwardToInbox: { url: "http://127.0.0.1:9", timeoutMs: 200 },
    })
    expect((await send(email())).status).toBe(200)
    expect(runtime.forwarding()).toMatchObject({ forwarded: 0, failed: 1 })
    const stats = (await (await call("/__admin/forwarding")).json()) as {
      failed: number
      target: string
    }
    expect(stats).toMatchObject({ failed: 1, target: "http://127.0.0.1:9" })
    const health = (await (await call("/health")).json()) as { forwardToInbox: string }
    expect(health.forwardToInbox).toBe("http://127.0.0.1:9")
  })
})

describe("inbound and webhooks", () => {
  test("signed like Svix (checked with node:crypto) with wall-clock timestamps, even on an advanced mock clock", async () => {
    const { runtime, call, deliveries } = harness()
    runtime.clock.advance(86_400_000)
    const created = await call("/__admin/inbound", {
      body: { from: "a@example.com", to: "care+x@care.gogeviti.com", subject: "s", text: "t" },
    })
    expect(created.status).toBe(201)
    await runtime.webhooks.idle()
    const [delivery] = deliveries
    const id = delivery?.headers.get("svix-id") as string
    const timestamp = delivery?.headers.get("svix-timestamp") as string
    const signature = delivery?.headers.get("svix-signature") as string
    expect(Math.abs(Number(timestamp) - Date.now() / 1000)).toBeLessThan(60)
    const expected = createHmac("sha256", Buffer.from(SECRET.slice(6), "base64"))
      .update(`${id}.${timestamp}.${delivery?.body}`)
      .digest("base64")
    expect(signature).toBe(`v1,${expected}`)
    const body = JSON.parse(delivery?.body as string) as {
      type: string
      data: Record<string, unknown>
    }
    expect(body.type).toBe("email.received")
    expect(body.data).not.toHaveProperty("text")
    expect(String(body.data.email_id)).toMatch(/^[A-Za-z0-9_-]{1,60}$/)
  })

  test("webhook presets: duplicate and drop", async () => {
    const { runtime, call, deliveries } = harness()
    const inbound = () =>
      call("/__admin/inbound", { body: { from: "a@example.com", to: "b@care.gogeviti.com" } })
    runtime.applyPreset("webhook_duplicate", "default")
    await inbound()
    await runtime.webhooks.idle()
    expect(deliveries).toHaveLength(2)
    runtime.applyPreset("webhook_drop", "default")
    await inbound()
    await runtime.webhooks.idle()
    expect(deliveries).toHaveLength(2)
  })

  test("inbound validation, listing, and unauthenticated namespaced downloads", async () => {
    const { call } = harness()
    const bad = [
      {},
      { from: "a@b.co" },
      { from: "a@b.co", to: [] },
      { from: "a@b.co", to: "c@d.co", attachments: [{ filename: "x" }] },
      { from: "a@b.co", to: "c@d.co", headers: "nope" },
    ]
    for (const body of bad) expect((await call("/__admin/inbound", { body })).status).toBe(400)
    const created = (await (
      await call("/__admin/inbound", {
        body: {
          from: "a@b.co",
          to: "c@d.co",
          attachments: [{ filename: "n.txt", content: btoa("note"), contentType: "text/plain" }],
        },
        headers: { "x-mockingbird-namespace": "w1" },
      })
    ).json()) as { id: string }
    const listed = (await (
      await call(`/emails/receiving/${created.id}/attachments`, {
        headers: { "x-mockingbird-namespace": "w1" },
      })
    ).json()) as { data: { download_url: string; size: number }[] }
    const url = new URL(listed.data[0]?.download_url as string)
    expect(url.pathname).toMatch(/^\/ns\/w1\/downloads\/inbound\//)
    const download = await call(`${url.pathname}`, { key: "" })
    expect(download.status).toBe(200)
    expect(download.headers.get("content-type")).toBe("text/plain")
    expect(await download.text()).toBe("note")
    expect((await call("/downloads/inbound/unknown", { key: "" })).status).toBe(404)
    const inbox = (await (
      await call("/__admin/inbound", { headers: { "x-mockingbird-namespace": "w1" } })
    ).json()) as { emails: { id: string }[] }
    expect(inbox.emails.map((e) => e.id)).toEqual([created.id])
  })
})

describe("served over HTTP", () => {
  test("plain fetch against the node server, webhooks to a real sink", async () => {
    const received: unknown[] = []
    const sink = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (request.headers.get("svix-signature")) received.push(await request.json())
        return Response.json({ ok: true })
      },
    })
    const server = await createServer({
      webhooks: { url: `http://127.0.0.1:${sink.port}/messaging/inbound/email`, secret: SECRET },
    })
    try {
      const sent = await fetch(`${server.url}/emails`, {
        method: "POST",
        headers: { authorization: "Bearer re_http", "content-type": "application/json" },
        body: JSON.stringify(email()),
      })
      expect(sent.status).toBe(200)
      await fetch(`${server.url}/__admin/inbound`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "a@b.co", to: "care+z@care.gogeviti.com" }),
      })
      const deadline = Date.now() + 3_000
      while (received.length < 1 && Date.now() < deadline) await Bun.sleep(20)
      expect(received).toHaveLength(1)
    } finally {
      await server.close()
      sink.stop(true)
    }
  })

  test("the serve target validates its flags", async () => {
    const runtime = await serveTarget.create(
      {
        "webhook-url": "http://127.0.0.1:1/x",
        "webhook-secret": SECRET,
        "forward-to-inbox": "http://127.0.0.1:2",
      },
      COMMON,
    )
    const health = (await (await runtime.fetch(new Request(`${API}/health`))).json()) as {
      webhooks: string
      forwardToInbox: string
    }
    expect(health).toMatchObject({ webhooks: "on", forwardToInbox: "http://127.0.0.1:2" })
    await expect(
      Promise.resolve().then(() => serveTarget.create({ "webhook-secret": "plain" }, COMMON)),
    ).rejects.toThrow("whsec_")
  })
})
