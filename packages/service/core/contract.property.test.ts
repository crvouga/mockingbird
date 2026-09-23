import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { type OpenAPIDocument, parseOpenAPIDocument } from "@crvouga/mockingbird-openapi"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import {
  basicAuth,
  bearerToken,
  Collection,
  createRuntime,
  createService,
  createWebhookHub,
  DroppedConnectionError,
  extractCodes,
  extractLinks,
  faultEffect,
  IdempotencyStore,
  type InstanceContext,
  jsonRes,
  NAMESPACE_HEADER,
  OutboxStore,
  requestFingerprint,
  signers,
  signTwilio,
  signV4,
  sigV4AccessKeyId,
} from "./src/index.js"

const params = fcParameters(process.env)

const document: OpenAPIDocument = parseOpenAPIDocument({
  openapi: "3.1.0",
  info: { title: "t", version: "1" },
  paths: {
    "/v1/notes": {
      post: { operationId: "notes.create", responses: { "200": { description: "ok" } } },
      get: { operationId: "notes.list", responses: { "200": { description: "ok" } } },
    },
  },
})

type Note = { id: string; text: string; to: string; createdAt: string }

const notesRuntime = (extra: Partial<Parameters<typeof createRuntime>[0]> = {}) => {
  const hub = createWebhookHub({ signer: signers.svix() })
  const runtime = createRuntime({
    name: "notes",
    document,
    credential: bearerToken,
    webhooks: hub,
    presets: {
      outage: {
        description: "every create fails",
        rules: [{ operationId: "notes.create", status: 503 }],
      },
      mangled: {
        description: "creates answer oddly",
        rules: [{ operationId: "notes.create", effect: "shout" }],
      },
      doubled: { description: "the next webhook arrives twice", webhook: { mode: "duplicate" } },
    },
    ...extra,
    create: (context: InstanceContext) => {
      const notes = new Collection<Note>(context.sqlite, context.namespace, "notes")
      const outbox = new OutboxStore<Note>(context.sqlite, context.namespace)
      const service = createService({
        document,
        sqlite: context.sqlite,
        namespace: context.namespace,
        now: context.clock.now,
        notFound: () => jsonRes(404, { detail: "Not Found" }),
        onError: (error) => {
          throw error
        },
        handlers: {
          "notes.create": async ({ body, request }) => {
            const value = body.kind === "json" ? (body.value as { text?: string }) : {}
            const shout = faultEffect(request, "shout") !== undefined
            const note: Note = {
              id: `n${notes.count() + 1}`,
              text: shout ? String(value.text).toUpperCase() : String(value.text),
              to: "a@example.com",
              createdAt: new Date(context.clock.now()).toISOString(),
            }
            notes.insert(note.id, note)
            outbox.record(note)
            hub.publish({ namespace: context.publicNamespace, type: "note.created", body: note })
            return jsonRes(200, note)
          },
          "notes.list": () =>
            jsonRes(
              200,
              notes.list({ order: "oldest" }).map((r) => r.value),
            ),
        },
      })
      return Object.assign(service, { outbox })
    },
  })
  return { runtime, hub }
}

const create = (text: string, headers: Record<string, string> = {}, base = "http://mock.local") =>
  new Request(`${base}/v1/notes`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ text }),
  })
const list = (headers: Record<string, string> = {}, base = "http://mock.local") =>
  new Request(`${base}/v1/notes`, { headers })
const admin = (path: string, init: RequestInit = {}) =>
  new Request(`http://mock.local/__admin${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) },
  })

describe("namespace carriers", () => {
  test("/ns/<name>/… selects a namespace and is stripped before routing", async () => {
    const { runtime } = notesRuntime()
    const made = await runtime.fetch(create("hi", {}, "http://mock.local/ns/w1"))
    expect(made.status).toBe(200)
    expect(made.headers.get("x-mockingbird")).toContain("ns=w1")
    expect(await (await runtime.fetch(list({}, "http://mock.local/ns/w1"))).json()).toHaveLength(1)
    expect(await (await runtime.fetch(list())).json()).toHaveLength(0)
    expect(await (await runtime.fetch(list({ [NAMESPACE_HEADER]: "w1" }))).json()).toHaveLength(1)
  })

  test("a mapped credential selects its namespace; the header still wins", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[A-Za-z0-9_]{8,24}$/),
        fc.stringMatching(/^[a-z][a-z0-9]{0,10}$/),
        async (key, namespace) => {
          const { runtime } = notesRuntime()
          const put = await runtime.fetch(
            admin("/credentials", {
              method: "PUT",
              body: JSON.stringify({ credentials: { [key]: namespace } }),
            }),
          )
          expect(put.status).toBe(200)
          const auth = { authorization: `Bearer ${key}` }
          await runtime.fetch(create("x", auth))
          const mine = (await (await runtime.fetch(list(auth))).json()) as unknown[]
          expect(mine).toHaveLength(1)
          const viaHeader = { ...auth, [NAMESPACE_HEADER]: `${namespace}-other` }
          expect(await (await runtime.fetch(list(viaHeader))).json()).toHaveLength(0)
          const listed = (await (await runtime.fetch(admin("/credentials"))).json()) as {
            credentials: { credential: string }[]
          }
          // Admin output never repeats a whole secret.
          expect(JSON.stringify(listed)).not.toContain(key)
        },
      ),
      { ...params, numRuns: params.numRuns ?? 20 },
    )
  })

  test("credential readers", () => {
    const basic = new Request("http://x", {
      headers: { authorization: `Basic ${btoa("AC123:secret:with:colons")}` },
    })
    expect(basicAuth(basic)).toEqual({ username: "AC123", password: "secret:with:colons" })
    const signed = new Request("http://x", {
      headers: {
        authorization:
          "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/bedrock/aws4_request, SignedHeaders=host, Signature=abc",
      },
    })
    expect(sigV4AccessKeyId(signed)).toBe("AKIDEXAMPLE")
  })
})

describe("fault presets, effects, drops and latency", () => {
  test("a preset answers for its operation only, in the calling namespace only", async () => {
    const { runtime } = notesRuntime()
    const added = await runtime.fetch(
      admin("/faults", {
        method: "POST",
        body: JSON.stringify({ preset: "outage", count: 1 }),
        headers: { [NAMESPACE_HEADER]: "a" },
      }),
    )
    expect(added.status).toBe(201)
    expect((await runtime.fetch(create("x", { [NAMESPACE_HEADER]: "b" }))).status).toBe(200)
    expect((await runtime.fetch(create("x", { [NAMESPACE_HEADER]: "a" }))).status).toBe(503)
    expect((await runtime.fetch(create("x", { [NAMESPACE_HEADER]: "a" }))).status).toBe(200)
    const presets = (await (await runtime.fetch(admin("/faults/presets"))).json()) as {
      presets: { name: string }[]
    }
    expect(presets.presets.map((p) => p.name)).toEqual(["outage", "mangled", "doubled"])
    expect(
      (await runtime.fetch(admin("/faults", { method: "POST", body: '{"preset":"nope"}' }))).status,
    ).toBe(404)
  })

  test("an effect reaches the handler instead of short-circuiting", async () => {
    const { runtime } = notesRuntime()
    runtime.applyPreset("mangled")
    const made = (await (await runtime.fetch(create("quiet"))).json()) as Note
    expect(made.text).toBe("QUIET")
    expect(runtime.metrics.report().faults).toBe(1)
  })

  test("drop rejects an in-process fetch like a dead connection", async () => {
    const { runtime } = notesRuntime()
    runtime.faults.add({ id: "d", operationId: "notes.create", drop: true, count: 1 })
    await expect(runtime.fetch(create("x"))).rejects.toBeInstanceOf(DroppedConnectionError)
    expect((await runtime.fetch(create("x"))).status).toBe(200)
  })

  test("a latency-only rule delays, then lets the request through", async () => {
    const { runtime } = notesRuntime()
    const added = await runtime.fetch(
      admin("/faults", { method: "POST", body: JSON.stringify({ latencyMs: 40, count: 1 }) }),
    )
    expect(added.status).toBe(201)
    const started = performance.now()
    expect((await runtime.fetch(create("x"))).status).toBe(200)
    expect(performance.now() - started).toBeGreaterThanOrEqual(35)
  })
})

describe("webhooks", () => {
  const receiver = () => {
    const received: { headers: Headers; body: string }[] = []
    return {
      received,
      fetch: async (request: Request) => {
        received.push({ headers: request.headers, body: await request.text() })
        return new Response("ok")
      },
    }
  }

  test("svix deliveries verify against an independent HMAC", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 16, maxLength: 32 }),
        fc.jsonValue(),
        async (key, payload) => {
          const secret = `whsec_${Buffer.from(key).toString("base64")}`
          const sink = receiver()
          const hub = createWebhookHub({
            signer: signers.svix(),
            fetch: sink.fetch,
            endpoints: [{ url: "http://app.local/hook", secret }],
          })
          hub.publish({ namespace: "default", type: "t", body: { payload } })
          await hub.idle()
          const [got] = sink.received
          expect(got).toBeDefined()
          const id = got?.headers.get("svix-id")
          const ts = got?.headers.get("svix-timestamp")
          const expected = createHmac("sha256", Buffer.from(key))
            .update(`${id}.${ts}.${got?.body}`)
            .digest("base64")
          expect(got?.headers.get("svix-signature")).toBe(`v1,${expected}`)
          expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThan(5)
        },
      ),
      { ...params, numRuns: params.numRuns ?? 20 },
    )
  })

  test("stripe-style and twilio signatures match independent HMACs", async () => {
    const sink = receiver()
    const hub = createWebhookHub({
      signer: signers.timestamped(),
      fetch: sink.fetch,
      endpoints: [{ url: "http://app.local/stripe", secret: "whsec_plain" }],
    })
    hub.publish({ namespace: "default", type: "invoice.paid", body: '{"id":"evt_1"}' })
    await hub.idle()
    const header = sink.received[0]?.headers.get("stripe-signature") ?? ""
    const t = /t=(\d+)/.exec(header)?.[1]
    const v1 = /v1=([0-9a-f]+)/.exec(header)?.[1]
    expect(v1).toBe(createHmac("sha256", "whsec_plain").update(`${t}.{"id":"evt_1"}`).digest("hex"))

    const url = "https://example.com/messaging/inbound/sms"
    const form = { To: "+15550001111", From: "+15557778888", Body: "hello" }
    const expected = createHmac("sha1", "token")
      .update(`${url}Body${form.Body}From${form.From}To${form.To}`)
      .digest("base64")
    expect(await signTwilio("token", url, form)).toBe(expected)
  })

  test("routing by event type and tags; duplicate, reorder and drop faults", async () => {
    const sink = receiver()
    const hub = createWebhookHub({ signer: signers.none(), fetch: sink.fetch })
    hub.setEndpoints("default", [
      { url: "http://app.local/mso", tags: { account: "mso" } },
      { url: "http://app.local/paid", events: ["invoice.paid"] },
    ])
    const order: string[] = []
    const send = (type: string, account: string) =>
      hub.publish({ namespace: "default", type, body: { type, account }, tags: { account } })
    send("invoice.paid", "pc")
    send("customer.updated", "mso")
    await hub.idle()
    expect(sink.received.map((r) => JSON.parse(r.body).account)).toEqual(["pc", "mso"])

    sink.received.length = 0
    hub.fault("default", { mode: "duplicate" })
    send("a", "mso")
    await hub.idle()
    expect(sink.received).toHaveLength(2)

    sink.received.length = 0
    hub.fault("default", { mode: "reorder" })
    send("first", "mso")
    send("second", "mso")
    await hub.idle()
    for (const r of sink.received) order.push(JSON.parse(r.body).type)
    expect(order).toEqual(["second", "first"])

    sink.received.length = 0
    hub.fault("default", { mode: "drop" })
    send("lost", "mso")
    await hub.idle()
    expect(sink.received).toHaveLength(0)
    expect(hub.deliveries().at(-1)?.state).toBe("dropped")
  })

  test("admin endpoints, events, and reset clears a namespace's deliveries", async () => {
    const { runtime, hub } = notesRuntime()
    await runtime.fetch(
      admin("/webhook-endpoints", {
        method: "PUT",
        body: JSON.stringify([{ url: "http://127.0.0.1:1/unreachable", secret: "whsec_AAAA" }]),
      }),
    )
    await runtime.fetch(create("x"))
    const events = (await (await runtime.fetch(admin("/webhooks/events"))).json()) as {
      events: { type: string; payload: { text: string } }[]
    }
    expect(events.events[0]?.type).toBe("note.created")
    expect(events.events[0]?.payload.text).toBe("x")
    await hub.idle()
    const deliveries = (await (await runtime.fetch(admin("/webhooks"))).json()) as {
      deliveries: { attempts: { error: string | null }[] }[]
    }
    expect(deliveries.deliveries[0]?.attempts[0]?.error).not.toBeNull()
    await runtime.reset()
    expect(hub.deliveries()).toHaveLength(0)
  })
})

describe("outbox and idempotency", () => {
  test("outbox filters by recipient and time; links and codes extract", async () => {
    const { runtime } = notesRuntime({
      admin: (rt) => ({
        "GET /outbox": ({ namespace }) =>
          jsonRes(200, {
            messages: (
              rt.instance(namespace) as unknown as { outbox: OutboxStore<Note> }
            ).outbox.list({ to: "A@example.com" }),
          }),
      }),
    })
    await runtime.fetch(create("one"))
    const got = (await (await runtime.fetch(admin("/outbox"))).json()) as { messages: Note[] }
    expect(got.messages.map((m) => m.text)).toEqual(["one"])
    expect(
      extractLinks(`<a href="https://x.test/r?a=1&amp;b=2">r</a> <a href='https://x.test/i'>i</a>`),
    ).toEqual(["https://x.test/r?a=1&b=2", "https://x.test/i"])
    expect(extractCodes("Your code is 123456. Ref 99.", 6)).toEqual(["123456"])
  })

  test("idempotency: replay, mismatch and in-flight conflict", async () => {
    const { runtime } = notesRuntime()
    const store = new IdempotencyStore(runtime.sqlite, "idem-test")
    const errors = {
      mismatch: () => jsonRes(400, { error: "mismatch" }),
      conflict: () => jsonRes(409, { error: "in_use" }),
    }
    let calls = 0
    const handler = async () => {
      calls++
      await new Promise((r) => setTimeout(r, 20))
      return jsonRes(200, { n: calls })
    }
    const fp = requestFingerprint("POST", "/v1/x", { a: 1, b: [2] })
    const [first, concurrent] = await Promise.all([
      store.run("k", fp, errors, handler),
      store.run("k", fp, errors, handler),
    ])
    expect(first.status).toBe(200)
    expect(concurrent.status).toBe(409)
    const replay = await store.run(
      "k",
      requestFingerprint("POST", "/v1/x", { b: [2], a: 1 }),
      errors,
      handler,
    )
    expect(await replay.json()).toEqual({ n: 1 })
    expect(calls).toBe(1)
    expect(
      (await store.run("k", requestFingerprint("POST", "/v1/x", { a: 2 }), errors, handler)).status,
    ).toBe(400)
  })
})

test("signV4 reproduces the AWS-published S3 GetObject example signature", async () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
  const headers = await signV4({
    method: "GET",
    url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
    body: new Uint8Array(),
    region: "us-east-1",
    service: "s3",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    headers: { range: "bytes=0-9" },
    now: new Date("2013-05-24T00:00:00Z"),
  })
  expect(headers.authorization).toBe(
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  )
})
