import { describe, expect, test } from "bun:test"
import { createRuntime, decodeRpcStatus, type Settings, TEMPO_PRESETS } from "./src/index.js"
import { createServer } from "./src/server.js"
import {
  exportTraces,
  type Fetch,
  type SpanInput,
  type TempoAuth,
  TempoTraceReader,
  traceqlAll,
  traceqlEquals,
  tracesExport,
} from "./test/consumer.js"
import { encodeTraceRequest } from "./test/otlp-proto.js"

const API = "http://tempo.mock"
/** Epoch seconds every fixture is placed around. */
const T = 1_700_000_000
const ns = (seconds: number, nanos = 0) => `${BigInt(seconds) * 1_000_000_000n + BigInt(nanos)}`

const TRACE_CHECKOUT = "5b8efff798038103d269b633813fc7a1"
const ROOT = "eee19b7ec3c1b101"
const CHILD = "eee19b7ec3c1b102"

type Overrides = { auth?: TempoAuth; orgId?: string; namespace?: string }

/** A runtime driven only through the consumer's reader and exporter. */
const harness = (settings?: Partial<Settings>) => {
  const runtime = createRuntime(settings ? { settings } : {})
  const fetchFor =
    (namespace?: string): Fetch =>
    (input, init) => {
      const headers = new Headers(init?.headers)
      if (namespace) headers.set("x-mockingbird-namespace", namespace)
      return runtime.fetch(new Request(input, { ...init, headers }))
    }
  const reader = ({ namespace, ...rest }: Overrides = {}) =>
    new TempoTraceReader({ baseUrl: API, fetchImpl: fetchFor(namespace), ...rest })
  const push = (
    payload: Record<string, unknown> | Uint8Array,
    { namespace, ...rest }: Overrides = {},
  ) => exportTraces({ baseUrl: API, fetchImpl: fetchFor(namespace), ...rest }, payload)
  const admin = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    runtime.fetch(
      new Request(`${API}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const raw = (path: string, init?: RequestInit) =>
    runtime.fetch(new Request(`${API}${path}`, init))
  return { runtime, reader, push, admin, raw }
}

const json = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes))

/** The synthetic checkout trace: a server span, and a client span it is the parent of. */
const checkoutSpans = (): SpanInput[] => [
  {
    traceId: TRACE_CHECKOUT,
    spanId: ROOT,
    name: "POST /checkout",
    kind: 2,
    startTimeUnixNano: ns(T),
    endTimeUnixNano: ns(T + 1, 500_000_000),
    attributes: { "user.id": "user-1", "session.id": "session-1", "http.status_code": 500 },
    events: [
      {
        name: "exception",
        timeUnixNano: ns(T + 1, 250_000_000),
        attributes: { "exception.type": "PaymentDeclined", "exception.escaped": false },
      },
    ],
    status: { code: 2, message: "payment declined" },
  },
  {
    traceId: TRACE_CHECKOUT,
    spanId: CHILD,
    parentSpanId: ROOT,
    name: "charge card",
    kind: 3,
    startTimeUnixNano: ns(T, 200_000_000),
    endTimeUnixNano: ns(T + 1, 100_000_000),
    attributes: { "user.id": "user-1", "mutation.id": "mutation-7", attempt: 2 },
    events: [{ name: "retry", timeUnixNano: ns(T, 900_000_000), attributes: { attempt: 1 } }],
  },
]
const CHECKOUT_RESOURCE = { "service.name": "checkout-api", "deployment.environment.name": "test" }

/** A one-span trace of `service` for `user`, starting `offsetSeconds` after `T`. */
const simpleTrace = (
  traceId: string,
  offsetSeconds: number,
  attributes: Record<string, string | number> = {},
  service = "checkout-api",
) =>
  tracesExport({ "service.name": service }, [
    {
      traceId,
      spanId: `${traceId.slice(16, 31)}1`,
      name: `job ${traceId.slice(-2)}`,
      startTimeUnixNano: ns(T + offsetSeconds),
      endTimeUnixNano: ns(T + offsetSeconds + 1),
      attributes,
    },
  ])

describe("acceptance: the consumer's trace reader and exporter against the emulator", () => {
  test("1. a trace with two related spans, events and attributes: search finds its metadata, lookup returns the spans and the parent link", async () => {
    const { reader, push, raw } = harness()
    const exported = await push(tracesExport(CHECKOUT_RESOURCE, checkoutSpans()))
    expect(exported.status).toBe(200)
    expect(exported.contentType).toContain("application/json")
    expect(json(exported.body)).toEqual({ partialSuccess: {} })

    const found = await reader().search({
      q: traceqlAll(),
      startSeconds: T - 60,
      endSeconds: T + 60,
    })
    expect(found).toEqual({
      ok: true,
      value: [
        {
          traceId: TRACE_CHECKOUT,
          startTimeUnixNano: ns(T),
          durationMs: 1500,
          rootServiceName: "checkout-api",
          rootTraceName: "POST /checkout",
        },
      ],
    })

    const trace = await reader().trace(TRACE_CHECKOUT)
    expect(trace).toEqual({
      ok: true,
      value: [
        {
          traceId: TRACE_CHECKOUT,
          spanId: ROOT,
          parentSpanId: null,
          name: "POST /checkout",
          serviceName: "checkout-api",
          startTimeUnixNano: ns(T),
          endTimeUnixNano: ns(T + 1, 500_000_000),
          attributes: { "user.id": "user-1", "session.id": "session-1", "http.status_code": 500 },
          resourceAttributes: CHECKOUT_RESOURCE,
          events: [
            {
              name: "exception",
              timeUnixNano: ns(T + 1, 250_000_000),
              attributes: { "exception.type": "PaymentDeclined", "exception.escaped": false },
            },
          ],
          status: { code: "error", message: "payment declined" },
        },
        {
          traceId: TRACE_CHECKOUT,
          spanId: CHILD,
          parentSpanId: ROOT,
          name: "charge card",
          serviceName: "checkout-api",
          startTimeUnixNano: ns(T, 200_000_000),
          endTimeUnixNano: ns(T + 1, 100_000_000),
          attributes: { "user.id": "user-1", "mutation.id": "mutation-7", attempt: 2 },
          resourceAttributes: CHECKOUT_RESOURCE,
          events: [{ name: "retry", timeUnixNano: ns(T, 900_000_000), attributes: { attempt: 1 } }],
          status: { code: "unset", message: null },
        },
      ],
    })

    // The wire shape is Tempo's, not OTLP/JSON: `batches`, base64 ids, enum names, and a
    // `status` object on every span (documented at /docs/tempo/latest/api_docs/).
    const wire = (await (await raw(`/api/traces/${TRACE_CHECKOUT}`)).json()) as {
      batches: { scopeSpans: { scope: unknown; spans: Record<string, unknown>[] }[] }[]
    }
    const [root, child] = wire.batches[0]?.scopeSpans[0]?.spans ?? []
    expect(wire.batches[0]?.scopeSpans[0]?.scope).toEqual({
      name: "@acme/telemetry",
      version: "1.0.0",
    })
    expect(root).toMatchObject({
      traceId: "W47/95gDgQPSabYzgT/HoQ==",
      spanId: "7uGbfsPBsQE=",
      kind: "SPAN_KIND_SERVER",
      startTimeUnixNano: ns(T),
      status: { message: "payment declined", code: "STATUS_CODE_ERROR" },
    })
    expect(root).not.toHaveProperty("parentSpanId")
    expect(child).toMatchObject({
      parentSpanId: "7uGbfsPBsQE=",
      kind: "SPAN_KIND_CLIENT",
      status: {},
    })
    const childAttributes = (child?.attributes ?? []) as { key: string; value: unknown }[]
    expect(childAttributes.find((kv) => kv.key === "attempt")).toEqual({
      key: "attempt",
      value: { intValue: "2" },
    })
  })

  test("2a. time windows are seconds at search and nanoseconds in the metadata, inclusive at both ends", async () => {
    const { reader, push } = harness()
    // Spans T .. T+1.5 s.
    await push(tracesExport(CHECKOUT_RESOURCE, checkoutSpans()))
    const window = async (startSeconds: number, endSeconds: number) => {
      const res = await reader().search({ q: traceqlAll(), startSeconds, endSeconds })
      if (!res.ok) throw new Error(res.error)
      return res.value.map((trace) => trace.startTimeUnixNano)
    }
    // The metadata is nanoseconds, as a string: no precision is lost to a JSON number.
    expect(await window(T - 10, T + 10)).toEqual([`${T}000000000`])
    // The trace starts exactly at the window's end: still inside.
    expect(await window(T - 10, T)).toEqual([ns(T)])
    expect(await window(T - 10, T - 1)).toEqual([])
    // The trace ends at T+1.5 s, so a window opening at T+1 overlaps it and one at T+2 does not.
    expect(await window(T + 1, T + 10)).toEqual([ns(T)])
    expect(await window(T + 2, T + 10)).toEqual([])

    // One nanosecond past the window's last second is outside it.
    const late = "5b8efff798038103d269b633813fc7a2"
    await push(
      tracesExport({ "service.name": "worker" }, [
        {
          traceId: late,
          spanId: "eee19b7ec3c1b201",
          name: "late",
          startTimeUnixNano: ns(T + 30, 1),
          endTimeUnixNano: ns(T + 31),
        },
      ]),
    )
    expect(await window(T + 20, T + 30)).toEqual([])
    expect(await window(T + 20, T + 31)).toEqual([ns(T + 30, 1)])
  })

  test("2b. equality filters exclude unrelated traces; limit and newest-first ordering are stable", async () => {
    const { reader, push } = harness()
    const ids = [
      "5b8efff798038103d269b633813fc7a1",
      "5b8efff798038103d269b633813fc7a2",
      "5b8efff798038103d269b633813fc7a3",
      "5b8efff798038103d269b633813fc7a4",
    ] as const
    await push(simpleTrace(ids[0], 0, { "user.id": "user-1", "session.id": "s-1" }))
    await push(simpleTrace(ids[1], 10, { "user.id": "user-2", "session.id": "s-1" }))
    await push(simpleTrace(ids[2], 20, { "user.id": "user-1", "session.id": "s-2" }))
    await push(simpleTrace(ids[3], 30, { "user.id": "user-1", "device.id": 42 }))
    const search = async (q: string, limit?: number) => {
      const res = await reader().search({
        q,
        startSeconds: T - 60,
        endSeconds: T + 600,
        ...(limit === undefined ? {} : { limit }),
      })
      if (!res.ok) throw new Error(res.error)
      return res.value.map((trace) => trace.traceId)
    }

    // Newest first.
    expect(await search(traceqlAll())).toEqual([ids[3], ids[2], ids[1], ids[0]])
    expect(await search(traceqlEquals({ "user.id": "user-1" }))).toEqual([ids[3], ids[2], ids[0]])
    expect(await search(traceqlEquals({ "user.id": "user-2" }))).toEqual([ids[1]])
    // A conjunction: both conditions on one span.
    expect(await search(traceqlEquals({ "user.id": "user-1", "session.id": "s-2" }))).toEqual([
      ids[2],
    ])
    expect(await search(traceqlEquals({ "user.id": "user-2", "session.id": "s-2" }))).toEqual([])
    // Types are compared exactly: the integer 42 is not the string "42".
    expect(await search(traceqlEquals({ "device.id": 42 }))).toEqual([ids[3]])
    expect(await search(traceqlEquals({ "device.id": "42" }))).toEqual([])
    expect(await search(traceqlEquals({ "user.id": "user-9" }))).toEqual([])
    // Scoped: the resource carries service.name, the span does not.
    expect(await search('{ resource.service.name = "checkout-api" }')).toHaveLength(4)
    expect(await search('{ span.service.name = "checkout-api" }')).toEqual([])

    // limit keeps the newest matches, and asking twice gives the same answer.
    const limited = await search(traceqlEquals({ "user.id": "user-1" }), 2)
    expect(limited).toEqual([ids[3], ids[2]])
    expect(await search(traceqlEquals({ "user.id": "user-1" }), 2)).toEqual(limited)
    expect(await search(traceqlAll(), 1)).toEqual([ids[3]])

    // Two traces starting at the same nanosecond come back in trace id order, every time.
    await push(simpleTrace("5b8efff798038103d269b633813fc7b2", 30, { "user.id": "user-3" }))
    await push(simpleTrace("5b8efff798038103d269b633813fc7b1", 30, { "user.id": "user-3" }))
    const tied = await search(traceqlEquals({ "user.id": "user-3" }))
    expect(tied).toEqual(["5b8efff798038103d269b633813fc7b1", "5b8efff798038103d269b633813fc7b2"])
    expect(await search(traceqlEquals({ "user.id": "user-3" }))).toEqual(tied)
  })

  test("3. an unknown trace is a 404; search errors are Tempo's 400 text; invalid TraceQL never matches everything", async () => {
    const { reader, push, raw } = harness()
    await push(tracesExport(CHECKOUT_RESOURCE, checkoutSpans()))

    expect(await reader().trace("5b8efff798038103d269b633813fc7ff")).toEqual({
      ok: true,
      value: null,
    })
    const missing = await raw("/api/traces/5b8efff798038103d269b633813fc7ff")
    expect(missing.status).toBe(404)
    expect(await missing.text()).toBe("")
    const malformed = await raw("/api/traces/not-hex")
    expect(malformed.status).toBe(400)
    expect(await malformed.text()).toBe(
      "trace IDs can only contain hex characters: invalid character 'n' at position 1",
    )

    const failure = async (query: string) => {
      const res = await raw(`/api/search?${query}`)
      return [res.status, res.headers.get("content-type"), await res.text()]
    }
    const TEXT = "text/plain; charset=utf-8"
    expect(await failure("limit=0")).toEqual([
      400,
      TEXT,
      "invalid limit: must be a positive number",
    ])
    expect(await failure("start=abc")).toEqual([
      400,
      TEXT,
      'invalid start: strconv.ParseUint: parsing "abc": invalid syntax',
    ])
    expect(await failure("start=10&end=5")).toEqual([
      400,
      TEXT,
      "http parameter start must be before end. received start=10 end=5",
    ])
    expect(await failure(`q=${encodeURIComponent("{ true }")}&tags=a%3Db`)).toEqual([
      400,
      TEXT,
      "invalid request: can't specify tags and q in the same query",
    ])

    // The reader surfaces Tempo's body as its error and gets no traces, though one is stored.
    const invalid = async (q: string) =>
      reader().search({ q, startSeconds: T - 60, endSeconds: T + 60 })
    expect(await invalid("{ .user.id = ")).toEqual({
      ok: false,
      status: 400,
      error: "invalid TraceQL query: parse error at line 1, col 14: syntax error: unexpected $end",
    })
    // A forgotten dot: Tempo's lexer reads a bare word as IDENTIFIER, valid nowhere here.
    expect(await invalid('{ user.id = "user-1" }')).toEqual({
      ok: false,
      status: 400,
      error:
        "invalid TraceQL query: parse error at line 1, col 3: syntax error: unexpected IDENTIFIER",
    })
    expect(await invalid("wharblgarbl")).toEqual({
      ok: false,
      status: 400,
      error:
        "invalid TraceQL query: parse error at line 1, col 1: syntax error: unexpected IDENTIFIER",
    })
    // Valid TraceQL the emulator does not evaluate is refused too, never widened to "all".
    for (const q of [
      '{ .user.id =~ "user-.*" }',
      '{ .user.id != "user-2" }',
      '{ .user.id = "user-1" || .user.id = "user-2" }',
      "{ status = error }",
      "{ duration > 1s }",
      "{ true } | count() > 1",
      '{ .user.id = "user-1" } && { .user.id = "user-2" }',
    ]) {
      const res = await invalid(q)
      expect(res.ok).toBe(false)
      if (res.ok) continue
      expect(res.status).toBe(400)
      expect(res.error).toStartWith("invalid TraceQL query: ")
      expect(res.error).toContain("not yet supported")
    }
    // The same store answers a valid query, so the rejections above were not an empty store.
    const valid = await invalid(traceqlEquals({ "user.id": "user-1" }))
    expect(valid.ok && valid.value.map((trace) => trace.traceId)).toEqual([TRACE_CHECKOUT])
  })

  test("4. tag discovery lists span attributes seen on a single span; tenants and namespaces do not leak tags or traces", async () => {
    const tenants = harness({ multitenancy: true })
    await tenants.push(tracesExport(CHECKOUT_RESOURCE, checkoutSpans()), { orgId: "tenant-a" })
    const a = tenants.reader({ orgId: "tenant-a" })
    const b = tenants.reader({ orgId: "tenant-b" })

    // `mutation.id` and `session.id` are each on one of the two spans; resource attributes
    // belong to the resource scope, event attributes to the event scope.
    expect(await a.spanTags()).toEqual({
      ok: true,
      value: ["attempt", "http.status_code", "mutation.id", "session.id", "user.id"],
    })
    const scoped = async (scope: string, orgId: string) =>
      (
        (await (
          await tenants.raw(`/api/v2/search/tags${scope ? `?scope=${scope}` : ""}`, {
            headers: { "X-Scope-OrgID": orgId },
          })
        ).json()) as { scopes: { name: string; tags: string[] }[] }
      ).scopes
    expect(await scoped("resource", "tenant-a")).toEqual([
      { name: "resource", tags: ["deployment.environment.name", "service.name"] },
    ])
    expect((await scoped("", "tenant-a")).map((scope) => scope.name)).toEqual([
      "resource",
      "span",
      "event",
      "intrinsic",
    ])

    // Another tenant: no tags, no search hits, no trace.
    expect(await b.spanTags()).toEqual({ ok: true, value: [] })
    expect(await scoped("span", "tenant-b")).toEqual([])
    expect(await b.search({ q: traceqlAll(), startSeconds: T - 60, endSeconds: T + 60 })).toEqual({
      ok: true,
      value: [],
    })
    expect(await b.trace(TRACE_CHECKOUT)).toEqual({ ok: true, value: null })
    expect((await a.trace(TRACE_CHECKOUT)).ok).toBe(true)
    // Tempo's own answer when the tenant header is missing under multi-tenancy.
    const anonymous = await tenants.raw("/api/v2/search/tags?scope=span")
    expect([anonymous.status, await anonymous.text()]).toEqual([401, "no org id\n"])
    const bogus = await tenants.raw("/api/v2/search/tags?scope=bogus", {
      headers: { "X-Scope-OrgID": "tenant-a" },
    })
    expect([bogus.status, await bogus.text()]).toEqual([400, "invalid scope: bogus"])

    // Namespaces (parallel test workers) are a second wall, with or without tenants.
    const workers = harness()
    await workers.push(tracesExport(CHECKOUT_RESOURCE, checkoutSpans()), { namespace: "worker-1" })
    expect((await workers.reader({ namespace: "worker-1" }).spanTags()).ok).toBe(true)
    expect(await workers.reader({ namespace: "worker-2" }).spanTags()).toEqual({
      ok: true,
      value: [],
    })
    expect(
      await workers
        .reader({ namespace: "worker-2" })
        .search({ q: traceqlAll(), startSeconds: T - 60, endSeconds: T + 60 }),
    ).toEqual({ ok: true, value: [] })
    expect(await workers.reader({ namespace: "worker-2" }).trace(TRACE_CHECKOUT)).toEqual({
      ok: true,
      value: null,
    })
    expect(
      (await workers.reader({ namespace: "worker-1" }).trace(TRACE_CHECKOUT)).ok &&
        (await workers.reader({ namespace: "worker-1" }).spanTags()),
    ).toMatchObject({ ok: true, value: expect.arrayContaining(["mutation.id"]) })
  })

  test("5. JSON and protobuf exports decode to the same trace; statuses, events and resource attributes round-trip; malformed exports get OTLP errors", async () => {
    const { reader, push, raw, admin } = harness()
    const fixture = tracesExport(CHECKOUT_RESOURCE, [
      ...checkoutSpans(),
      {
        traceId: TRACE_CHECKOUT,
        spanId: "eee19b7ec3c1b103",
        parentSpanId: ROOT,
        name: "publish receipt",
        kind: 4,
        startTimeUnixNano: ns(T + 1, 100_000_000),
        endTimeUnixNano: ns(T + 1, 400_000_000),
        attributes: { ratio: 0.25, sampled: true, "tags.list": ["a", "b"] },
        links: [{ traceId: "5b8efff798038103d269b633813fc7c9", spanId: "eee19b7ec3c1b999" }],
        status: { code: 1 },
      },
    ])
    const asJson = await push(fixture, { namespace: "json" })
    const asProtobuf = await push(encodeTraceRequest(fixture), { namespace: "protobuf" })
    expect([asJson.status, asProtobuf.status]).toEqual([200, 200])
    // An empty ExportTraceServiceResponse, in the request's encoding.
    expect(asProtobuf.contentType).toBe("application/x-protobuf")
    expect(asProtobuf.body).toHaveLength(0)

    const wire = async (namespace: string) =>
      (
        await raw(`/api/traces/${TRACE_CHECKOUT}`, {
          headers: { "x-mockingbird-namespace": namespace },
        })
      ).json()
    expect(await wire("protobuf")).toEqual(await wire("json"))

    const read = await reader({ namespace: "protobuf" }).trace(TRACE_CHECKOUT)
    if (!read.ok || read.value === null) throw new Error("trace not found")
    expect(read.value.map((span) => [span.name, span.status])).toEqual([
      ["POST /checkout", { code: "error", message: "payment declined" }],
      ["charge card", { code: "unset", message: null }],
      ["publish receipt", { code: "ok", message: null }],
    ])
    expect(read.value[0]?.events).toEqual([
      {
        name: "exception",
        timeUnixNano: ns(T + 1, 250_000_000),
        attributes: { "exception.type": "PaymentDeclined", "exception.escaped": false },
      },
    ])
    expect(read.value.map((span) => span.resourceAttributes)).toEqual([
      CHECKOUT_RESOURCE,
      CHECKOUT_RESOURCE,
      CHECKOUT_RESOURCE,
    ])
    expect(read.value[2]?.attributes).toEqual({
      ratio: 0.25,
      sampled: true,
      "tags.list": ["a", "b"],
    })
    // An array attribute matches when any element does.
    const byElement = await reader({ namespace: "protobuf" }).search({
      q: '{ span.tags.list = "b" }',
      startSeconds: T - 60,
      endSeconds: T + 60,
    })
    expect(byElement.ok && byElement.value.map((trace) => trace.traceId)).toEqual([TRACE_CHECKOUT])

    // Malformed exports: google.rpc.Status, in the encoding of the request.
    const post = async (body: BodyInit, contentType: string) => {
      const res = await raw("/v1/traces", {
        method: "POST",
        headers: { "content-type": contentType, "x-mockingbird-namespace": "malformed" },
        body,
      })
      return { res, bytes: new Uint8Array(await res.arrayBuffer()) }
    }
    const notJson = await post("{not json", "application/json")
    expect(notJson.res.status).toBe(400)
    expect(json(notJson.bytes)).toMatchObject({ code: 3 })
    const wrongShape = await post(JSON.stringify({ resourceSpans: "nope" }), "application/json")
    expect(wrongShape.res.status).toBe(400)
    expect(json(wrongShape.bytes)).toMatchObject({ code: 3 })

    const truncated = await post(new Uint8Array([0x0a, 0x7f, 0x01]), "application/x-protobuf")
    expect(truncated.res.status).toBe(400)
    expect(truncated.res.headers.get("content-type")).toBe("application/x-protobuf")
    expect(decodeRpcStatus(truncated.bytes)).toMatchObject({ code: 3 })
    expect(decodeRpcStatus(truncated.bytes).message).not.toBe("")

    // Tempo's distributor: its own wording for a span without usable ids.
    const span = (ids: { traceId?: string; spanId?: string }) =>
      JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{ name: "x", ...ids }] }] }] })
    const noTraceId = await post(span({ spanId: ROOT }), "application/json")
    expect([noTraceId.res.status, json(noTraceId.bytes)]).toEqual([
      400,
      { code: 3, message: "trace ids must be 128 bit, received 0 bits" },
    ])
    const zeroSpanId = await post(
      span({ traceId: TRACE_CHECKOUT, spanId: "0000000000000000" }),
      "application/json",
    )
    expect([zeroSpanId.res.status, json(zeroSpanId.bytes)]).toEqual([
      400,
      { code: 3, message: "span ids must be 64 bit and not all zero, received 64 bits" },
    ])
    // The OTLP receiver's own 415, plain text whatever was sent.
    const csv = await post("a,b", "text/csv")
    expect([csv.res.status, new TextDecoder().decode(csv.bytes)]).toEqual([
      415,
      "415 unsupported media type, supported: [application/json, application/x-protobuf]",
    ])
    // Nothing from a refused export is stored.
    const stored = (await (await admin("/traces", undefined, "GET")).json()) as {
      traces: unknown[]
    }
    expect(stored.traces).toEqual([])
    const malformedSpans = (await (
      await raw("/__admin/spans", { headers: { "x-mockingbird-namespace": "malformed" } })
    ).json()) as { spans: unknown[] }
    expect(malformedSpans.spans).toEqual([])
  })

  test("6. no-auth, Bearer and Basic modes admit the same unchanged clients; wrong credentials fail", async () => {
    const window = { q: traceqlAll(), startSeconds: T - 60, endSeconds: T + 60 }
    const payload = () => tracesExport(CHECKOUT_RESOURCE, checkoutSpans())

    // Local deployment: no credentials needed, and stray ones are ignored.
    const local = harness()
    expect((await local.push(payload())).status).toBe(200)
    expect((await local.reader().search(window)).ok).toBe(true)
    expect(
      (await local.reader({ auth: { kind: "bearer", token: "anything" } }).search(window)).ok,
    ).toBe(true)

    // Bearer.
    const bearer = harness({ bearerTokens: ["tempo-token-1"] })
    const good: TempoAuth = { kind: "bearer", token: "tempo-token-1" }
    expect((await bearer.push(payload(), { auth: good })).status).toBe(200)
    const read = await bearer.reader({ auth: good }).search(window)
    expect(read.ok && read.value.map((trace) => trace.traceId)).toEqual([TRACE_CHECKOUT])
    expect((await bearer.reader({ auth: good }).trace(TRACE_CHECKOUT)).ok).toBe(true)
    expect((await bearer.reader({ auth: good }).spanTags()).ok).toBe(true)
    const wrong: TempoAuth = { kind: "bearer", token: "tempo-token-2" }
    expect(await bearer.reader({ auth: wrong }).search(window)).toEqual({
      ok: false,
      status: 401,
      error: "Unauthorized\n",
    })
    expect(await bearer.reader({ auth: wrong }).trace(TRACE_CHECKOUT)).toMatchObject({
      ok: false,
      status: 401,
    })
    expect(await bearer.reader().spanTags()).toMatchObject({ ok: false, status: 401 })
    expect((await bearer.push(payload(), { auth: wrong })).status).toBe(401)
    expect((await bearer.push(payload())).status).toBe(401)
    // Basic credentials are not a Bearer token.
    expect(
      await bearer
        .reader({ auth: { kind: "basic", username: "tempo-token-1", token: "tempo-token-1" } })
        .search(window),
    ).toMatchObject({ ok: false, status: 401 })

    // Grafana Cloud style Basic: instance id and access token.
    const basic = harness({ basicUsers: [{ username: "123456", password: "cloud-token-1" }] })
    const cloud: TempoAuth = { kind: "basic", username: "123456", token: "cloud-token-1" }
    expect((await basic.push(payload(), { auth: cloud })).status).toBe(200)
    const cloudRead = await basic.reader({ auth: cloud }).search(window)
    expect(cloudRead.ok && cloudRead.value).toHaveLength(1)
    expect(
      await basic
        .reader({ auth: { kind: "basic", username: "123456", token: "cloud-token-2" } })
        .search(window),
    ).toMatchObject({ ok: false, status: 401 })
    expect(
      await basic
        .reader({ auth: { kind: "basic", username: "654321", token: "cloud-token-1" } })
        .search(window),
    ).toMatchObject({ ok: false, status: 401 })
    expect(await basic.reader().search(window)).toMatchObject({ ok: false, status: 401 })

    // The refusal is the gateway's, so it is whatever the deployment's gateway says.
    const configured = await basic.admin(
      "/settings",
      {
        unauthorized: {
          status: 401,
          body: '{"status":"error","message":"authentication error: invalid token"}',
          contentType: "application/json",
        },
      },
      "PUT",
    )
    expect(configured.status).toBe(200)
    expect(await basic.reader().search(window)).toEqual({
      ok: false,
      status: 401,
      error: '{"status":"error","message":"authentication error: invalid token"}',
    })
  })
})

describe("test controls", () => {
  test("exact spans are injected through /__admin/traces, timed by the emulator clock when they carry no time", async () => {
    const { runtime, reader, admin } = harness({ bearerTokens: ["tempo-token-1"] })
    runtime.clock.freeze()
    runtime.clock.set(T * 1000)
    const injected = await admin("/traces", {
      resourceSpans: tracesExport(CHECKOUT_RESOURCE, checkoutSpans()).resourceSpans,
    })
    expect(await injected.json()).toEqual({
      accepted: 2,
      tenant: "single-tenant",
      traceIds: [TRACE_CHECKOUT],
    })
    // No start time: the span starts (and ends) at the emulator clock.
    const untimed = "5b8efff798038103d269b633813fc7d1"
    runtime.clock.advance(90_000)
    await admin("/traces", {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "cron" } }] },
          scopeSpans: [{ spans: [{ traceId: untimed, spanId: "eee19b7ec3c1b301", name: "tick" }] }],
        },
      ],
    })
    const auth: TempoAuth = { kind: "bearer", token: "tempo-token-1" }
    const exact = await reader({ auth }).trace(TRACE_CHECKOUT)
    expect(exact.ok && exact.value?.map((span) => span.startTimeUnixNano)).toEqual([
      ns(T),
      ns(T, 200_000_000),
    ])
    const found = await reader({ auth }).search({
      q: '{ resource.service.name = "cron" }',
      startSeconds: T + 90,
      endSeconds: T + 91,
    })
    expect(found).toEqual({
      ok: true,
      value: [
        {
          traceId: untimed,
          startTimeUnixNano: ns(T + 90),
          durationMs: 0,
          rootServiceName: "cron",
          rootTraceName: "tick",
        },
      ],
    })
    const listed = (await (await admin("/traces")).json()) as { traces: { traceID: string }[] }
    expect(listed.traces.map((trace) => trace.traceID)).toEqual([TRACE_CHECKOUT, untimed])
    const refused = await admin("/traces", { resourceSpans: [{ scopeSpans: [{ spans: [{}] }] }] })
    expect(refused.status).toBe(400)
    // The clock is also driven over HTTP.
    const clock = await admin("/clock", { set: (T + 300) * 1000, freeze: true })
    expect(((await clock.json()) as { now: number }).now).toBe((T + 300) * 1000)
  })

  test("one-shot outages: ingest, query and auth each fail once, then recover", async () => {
    const { reader, push, admin, raw } = harness()
    const window = { q: traceqlAll(), startSeconds: T - 60, endSeconds: T + 60 }
    const arm = async (preset: string) =>
      expect((await admin("/faults", { preset, count: 1 })).status).toBeLessThan(300)

    await arm("ingest_unavailable")
    const down = await push(tracesExport(CHECKOUT_RESOURCE, checkoutSpans()))
    expect([down.status, json(down.body)]).toEqual([503, { code: 14, message: "unavailable" }])
    expect((await reader().search(window)).ok && (await reader().search(window))).toEqual({
      ok: true,
      value: [],
    })
    // The retry lands.
    expect((await push(tracesExport(CHECKOUT_RESOURCE, checkoutSpans()))).status).toBe(200)

    await arm("ingest_rate_limited")
    const limited = await push(encodeTraceRequest(tracesExport(CHECKOUT_RESOURCE, checkoutSpans())))
    expect(limited.status).toBe(429)
    expect(decodeRpcStatus(limited.body)).toMatchObject({ code: 8 })
    expect(decodeRpcStatus(limited.body).message).toStartWith("RATE_LIMITED: ")

    await arm("query_unavailable")
    expect(await reader().search(window)).toEqual({
      ok: false,
      status: 503,
      error: "Service Unavailable",
    })
    expect((await reader().search(window)).ok).toBe(true)

    await arm("query_timeout")
    expect(await reader().trace(TRACE_CHECKOUT)).toEqual({
      ok: false,
      status: 504,
      error: "context deadline exceeded",
    })
    expect((await reader().trace(TRACE_CHECKOUT)).ok).toBe(true)

    await arm("query_rate_limited")
    expect(await reader().spanTags()).toEqual({
      ok: false,
      status: 429,
      error: "too many outstanding requests",
    })
    await arm("query_server_error")
    expect(await reader().spanTags()).toEqual({ ok: false, status: 500, error: "internal error" })
    expect((await reader().spanTags()).ok).toBe(true)

    // An auth error with valid (here: no) credentials, once.
    await arm("unauthorized")
    expect(await reader().search(window)).toEqual({
      ok: false,
      status: 401,
      error: "Unauthorized\n",
    })
    expect((await reader().search(window)).ok).toBe(true)

    // A dropped connection: the reader reports a transport failure, not a status.
    await arm("query_dropped")
    expect(await reader().search(window)).toMatchObject({ ok: false, status: null })
    await arm("ingest_dropped")
    await expect(push(tracesExport(CHECKOUT_RESOURCE, checkoutSpans()))).rejects.toThrow()
    await arm("ingest_server_error")
    expect(
      (
        await raw("/v1/traces", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(tracesExport(CHECKOUT_RESOURCE, checkoutSpans())),
        })
      ).status,
    ).toBe(500)
  })

  test("every documented preset is registered", async () => {
    const { admin } = harness()
    const listed = (await (await admin("/faults/presets")).json()) as {
      presets: { name: string }[]
    }
    // Tempo's own presets, beside the standard ones every emulator has.
    expect(listed.presets.map((preset) => preset.name)).toEqual(
      expect.arrayContaining([
        "ingest_dropped",
        "ingest_rate_limited",
        "ingest_server_error",
        "ingest_unavailable",
        "query_dropped",
        "query_rate_limited",
        "query_server_error",
        "query_timeout",
        "query_unavailable",
        "unauthorized",
      ]),
    )
    expect(listed.presets.map((preset) => preset.name)).toEqual(
      expect.arrayContaining(Object.keys(TEMPO_PRESETS)),
    )
  })

  test("snapshot, restore and reset; queries over recorded spans are deterministic", async () => {
    const { reader, push, admin } = harness()
    const window = { q: traceqlAll(), startSeconds: T - 60, endSeconds: T + 600 }
    const ids = async () => {
      const res = await reader().search(window)
      if (!res.ok) throw new Error(res.error)
      return res.value.map((trace) => trace.traceId)
    }
    await push(tracesExport(CHECKOUT_RESOURCE, checkoutSpans()))
    const snapshot = (await (await admin("/snapshots", {})).json()) as { id: string }
    await push(simpleTrace("5b8efff798038103d269b633813fc7e1", 100, { "user.id": "user-1" }))
    expect(await ids()).toEqual(["5b8efff798038103d269b633813fc7e1", TRACE_CHECKOUT])
    // The same recorded spans answer the same way, body for body.
    const first = await (await reader().trace(TRACE_CHECKOUT)).ok
    expect(JSON.stringify(await reader().search(window))).toBe(
      JSON.stringify(await reader().search(window)),
    )
    expect(first).toBe(true)

    expect((await admin(`/snapshots/${snapshot.id}/restore`, {})).status).toBe(200)
    expect(await ids()).toEqual([TRACE_CHECKOUT])
    expect(await reader().trace("5b8efff798038103d269b633813fc7e1")).toEqual({
      ok: true,
      value: null,
    })

    await admin("/settings", { leftPadTraceIds: true }, "PUT")
    expect((await admin("/reset", {})).status).toBeLessThan(300)
    expect(await ids()).toEqual([])
    expect(await reader().spanTags()).toEqual({ ok: true, value: [] })
    // Reset also returns the settings to their defaults.
    expect(await (await admin("/settings")).json()).toMatchObject({
      leftPadTraceIds: false,
      multitenancy: false,
      bearerTokens: [],
    })
  })

  test("settings: trace ids are trimmed like Tempo's unless left-padding is on; bad settings are refused", async () => {
    const { reader, push, admin, raw } = harness()
    const short = "0000000000000000d269b633813fc7f1"
    await push(simpleTrace(short, 0))
    const window = { q: traceqlAll(), startSeconds: T - 60, endSeconds: T + 60 }
    // Tempo prints a trace id without its leading zeros, and takes it back that way.
    const trimmed = await reader().search(window)
    expect(trimmed.ok && trimmed.value.map((trace) => trace.traceId)).toEqual(["d269b633813fc7f1"])
    const fetched = await reader().trace("d269b633813fc7f1")
    expect(fetched.ok && fetched.value?.map((span) => span.traceId)).toEqual([short])

    expect((await admin("/settings", { leftPadTraceIds: true }, "PUT")).status).toBe(200)
    const padded = await reader().search(window)
    expect(padded.ok && padded.value.map((trace) => trace.traceId)).toEqual([short])

    for (const bad of [
      { bearerTokens: "tempo-token-1" },
      { basicUsers: ["user"] },
      { multitenancy: "yes" },
      { defaultLimit: 0 },
      { unauthorized: { status: 200 } },
    ]) {
      expect((await admin("/settings", bad, "PUT")).status).toBe(400)
    }
    expect((await admin("/settings", { defaultLimit: 1 }, "PUT")).status).toBe(200)
    await push(simpleTrace("5b8efff798038103d269b633813fc7f2", 10))
    // The reader always sends a limit; without one the configured default applies.
    const unlimited = (await (await raw(`/api/search?start=${T - 60}&end=${T + 60}`)).json()) as {
      traces: unknown[]
    }
    expect(unlimited.traces).toHaveLength(1)
  })
})

describe("contract", () => {
  test("health, the namespace carriers, and a journal without span contents", async () => {
    const { runtime, push, admin, raw } = harness({
      bearerTokens: ["tempo-token-1", "tempo-token-2"],
    })
    const health = (await (await admin("/health")).json()) as { service: string }
    expect(health.service).toBe("tempo")

    // A credential maps to a namespace: the exporter and the reader need no extra header.
    await admin("/credentials", { credentials: { "tempo-token-2": "worker-2" } }, "PUT")
    await push(tracesExport(CHECKOUT_RESOURCE, checkoutSpans()), {
      auth: { kind: "bearer", token: "tempo-token-2" },
    })
    const withToken = (token: string) =>
      new TempoTraceReader({
        baseUrl: API,
        auth: { kind: "bearer", token },
        fetchImpl: (input, init) => runtime.fetch(new Request(input, init)),
      })
    expect((await withToken("tempo-token-2").trace(TRACE_CHECKOUT)).ok).toBe(true)
    expect(await withToken("tempo-token-1").trace(TRACE_CHECKOUT)).toEqual({
      ok: true,
      value: null,
    })
    // The path prefix carries the namespace too.
    const prefixed = await raw(`/__admin/ns/worker-2/api/traces/${TRACE_CHECKOUT}`, {
      headers: { authorization: "Bearer tempo-token-1" },
    })
    expect(prefixed.status).toBe(200)

    // The journal records that an export happened, never what the spans said.
    const journal = JSON.stringify(await (await admin("/requests?namespace=worker-2")).json())
    expect(journal).toContain("ExportTraces")
    expect(journal).not.toContain("PaymentDeclined")
    expect(journal).not.toContain("payment declined")
    expect(journal).not.toContain("mutation-7")
  })

  test("the state view lists the stored spans", async () => {
    const { runtime, push } = harness()
    await push(tracesExport(CHECKOUT_RESOURCE, checkoutSpans()))
    const names = runtime.state().collections.map((collection) => collection.name)
    expect(names).toEqual(expect.arrayContaining(["spans", "settings"]))
  })
})

describe("served over HTTP", () => {
  test("the exporter and the reader work against the node server with plain fetch", async () => {
    const server = await createServer({
      settings: { basicUsers: [{ username: "123456", password: "cloud-token-1" }] },
    })
    try {
      const auth: TempoAuth = { kind: "basic", username: "123456", token: "cloud-token-1" }
      const fetchImpl: Fetch = (input, init) => fetch(input, init)
      const fixture = tracesExport(CHECKOUT_RESOURCE, checkoutSpans())
      expect((await exportTraces({ baseUrl: server.url, auth, fetchImpl }, fixture)).status).toBe(
        200,
      )
      expect(
        (await exportTraces({ baseUrl: server.url, auth, fetchImpl }, encodeTraceRequest(fixture)))
          .status,
      ).toBe(200)
      const reader = new TempoTraceReader({ baseUrl: server.url, auth, fetchImpl })
      const found = await reader.search({
        q: traceqlEquals({ "mutation.id": "mutation-7" }),
        startSeconds: T - 60,
        endSeconds: T + 60,
      })
      expect(found.ok && found.value.map((trace) => trace.traceId)).toEqual([TRACE_CHECKOUT])
      const trace = await reader.trace(TRACE_CHECKOUT)
      expect(trace.ok && trace.value?.map((span) => span.name)).toEqual([
        "POST /checkout",
        "charge card",
      ])
      expect((await reader.spanTags()).ok).toBe(true)
      const anonymous = await fetch(`${server.url}/api/search`)
      expect(anonymous.status).toBe(401)
      const response = await fetch(`${server.url}/__admin/health`)
      expect(response.headers.get("x-mockingbird")).toBeTruthy()
    } finally {
      await server.close()
    }
  })
})
