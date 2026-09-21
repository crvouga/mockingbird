import { describe, expect, test } from "bun:test"
import { type OpenAPIDocument, parseOpenAPIDocument } from "@crvouga/mockingbird-openapi"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import {
  ADMIN_KEY_HEADER,
  annotateResponse,
  Collection,
  createClock,
  createJournal,
  createRng,
  createRuntime,
  createService,
  type InstanceContext,
  jsonRes,
  MOCKINGBIRD_HEADER,
  NAMESPACE_HEADER,
  PACKAGE_VERSION,
  parseDuration,
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
    "/v1/notes/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      get: { operationId: "notes.retrieve", responses: { "200": { description: "ok" } } },
    },
  },
})

/** A minimal real service: notes in a Collection, auth behind `x-key`. */
const notesService = (context: InstanceContext) => {
  const notes = new Collection<{ id: string; text: string; at: number }>(
    context.sqlite,
    context.namespace,
    "notes",
  )
  const service = createService({
    document,
    sqlite: context.sqlite,
    namespace: context.namespace,
    now: context.clock.now,
    notFound: () => jsonRes(404, { detail: "Not Found" }),
    onError: (error) => {
      throw error
    },
    before: ({ request }) =>
      request.headers.has("x-key") ? undefined : jsonRes(401, { detail: "no key" }),
    handlers: {
      "notes.create": async ({ body, now }) => {
        const value = body.kind === "json" ? (body.value as { text?: unknown }) : {}
        const text = String(value.text ?? "")
        const id = `note_${notes.nextSequence()}`
        notes.insert(id, { id, text, at: now() })
        return jsonRes(200, notes.get(id))
      },
      "notes.list": () => jsonRes(200, { data: notes.list().map((n) => n.value) }),
      "notes.retrieve": ({ params }) => {
        const note = notes.get(params.id as string)
        return note ? jsonRes(200, note) : jsonRes(404, { detail: "missing" })
      },
    },
  })
  return { fetch: service.fetch, reset: service.reset }
}

const call = (
  runtime: { fetch(request: Request): Promise<Response> },
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string> } = {},
) =>
  runtime.fetch(
    new Request(`http://mock.local${path}`, {
      method,
      headers: { "content-type": "application/json", "x-key": "k", ...init.headers },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
  )

const notesIn = async (runtime: Parameters<typeof call>[0], namespace?: string) => {
  const headers = namespace ? { [NAMESPACE_HEADER]: namespace } : {}
  const res = await call(runtime, "GET", "/v1/notes", { headers })
  return ((await res.json()) as { data: { text: string }[] }).data.map((n) => n.text).sort()
}

describe("clock", () => {
  test("advance and set compose like arithmetic on a frozen clock", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4_000_000_000_000 }),
        fc.array(fc.integer({ min: -86_400_000, max: 86_400_000 }), { maxLength: 20 }),
        (start, deltas) => {
          const clock = createClock(() => 0)
          clock.freeze()
          clock.set(start)
          for (const delta of deltas) clock.advance(delta)
          expect(clock.now()).toBe(start + deltas.reduce((a, b) => a + b, 0))
        },
      ),
      params,
    )
  })

  test("a live clock keeps its offset across unfreeze", () => {
    let source = 1_000
    const clock = createClock(() => source)
    clock.advance(500)
    clock.freeze()
    source = 9_000
    expect(clock.now()).toBe(1_500)
    clock.unfreeze()
    source = 9_100
    expect(clock.now()).toBe(1_600)
    clock.reset()
    expect(clock.now()).toBe(9_100)
  })

  test("parseDuration reads ms and unit suffixes", () => {
    expect(parseDuration(250)).toBe(250)
    expect(parseDuration("90s")).toBe(90_000)
    expect(parseDuration("15m")).toBe(900_000)
    expect(parseDuration("2h")).toBe(7_200_000)
    expect(parseDuration("3d")).toBe(259_200_000)
    expect(parseDuration("-1h")).toBe(-3_600_000)
    expect(parseDuration("soon")).toBeUndefined()
  })
})

describe("rng", () => {
  test("the same seed replays the same stream, in range", () => {
    fc.assert(
      fc.property(fc.oneof(fc.integer(), fc.string()), (seed) => {
        const a = createRng(seed)
        const b = createRng(seed)
        const first = Array.from({ length: 16 }, () => a.next())
        expect(Array.from({ length: 16 }, () => b.next())).toEqual(first)
        for (const x of first) expect(x >= 0 && x < 1).toBe(true)
        a.reset()
        expect(Array.from({ length: 16 }, () => a.next())).toEqual(first)
      }),
      params,
    )
  })
})

describe("runtime", () => {
  test("GET /health answers without vendor credentials", async () => {
    const runtime = createRuntime({
      name: "notes",
      document,
      create: notesService,
      describe: () => ({ corpus: "v1" }),
    })
    const res = await runtime.fetch(new Request("http://mock.local/health"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({ status: "ok", service: "notes", corpus: "v1" })
    // The vendor gate still applies to vendor routes.
    const vendor = await runtime.fetch(new Request("http://mock.local/v1/notes"))
    expect(vendor.status).toBe(401)
  })

  test("the admin key gates /__admin but not /health", async () => {
    const runtime = createRuntime({
      name: "notes",
      document,
      create: notesService,
      adminKey: "secret",
    })
    expect((await runtime.fetch(new Request("http://mock.local/__admin/clock"))).status).toBe(401)
    const ok = await runtime.fetch(
      new Request("http://mock.local/__admin/clock", { headers: { [ADMIN_KEY_HEADER]: "secret" } }),
    )
    expect(ok.status).toBe(200)
    expect((await runtime.fetch(new Request("http://mock.local/health"))).status).toBe(200)
  })

  test("namespaces isolate writes, resets and restores", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9-]{0,11}$/), {
          minLength: 2,
          maxLength: 4,
        }),
        fc.array(fc.stringMatching(/^[a-z]{1,8}$/), { minLength: 1, maxLength: 5 }),
        async (namespaces, texts) => {
          const runtime = createRuntime({ name: "notes", document, create: notesService })
          for (const ns of namespaces) {
            for (const text of texts) {
              await call(runtime, "POST", "/v1/notes", {
                body: { text: `${ns}:${text}` },
                headers: { [NAMESPACE_HEADER]: ns },
              })
            }
          }
          for (const ns of namespaces) {
            expect(await notesIn(runtime, ns)).toEqual(texts.map((t) => `${ns}:${t}`).sort())
          }
          const [first, second] = namespaces as [string, string]
          await runtime.reset(first)
          expect(await notesIn(runtime, first)).toEqual([])
          expect(await notesIn(runtime, second)).toEqual(texts.map((t) => `${second}:${t}`).sort())
        },
      ),
      { ...params, numRuns: Math.min(params.numRuns ?? 100, 25) },
    )
  })

  test("a snapshot restores exactly, discarding later writes", async () => {
    const runtime = createRuntime({ name: "notes", document, create: notesService })
    await call(runtime, "POST", "/v1/notes", { body: { text: "kept" } })
    const snap = await runtime.fetch(
      new Request("http://mock.local/__admin/snapshots", { method: "POST" }),
    )
    const { id } = (await snap.json()) as { id: string }
    const discarded = (await (
      await call(runtime, "POST", "/v1/notes", { body: { text: "discarded" } })
    ).json()) as { id: string }
    expect(await notesIn(runtime)).toEqual(["discarded", "kept"])
    await runtime.fetch(
      new Request(`http://mock.local/__admin/snapshots/${id}/restore`, { method: "POST" }),
    )
    expect(await notesIn(runtime)).toEqual(["kept"])
    // Sequences roll back too, so the next write replays the discarded write's id.
    const next = (await (
      await call(runtime, "POST", "/v1/notes", { body: { text: "x" } })
    ).json()) as {
      id: string
    }
    expect(next.id).toBe(discarded.id)
  })

  test("the admin clock drives the service's timestamps", async () => {
    const runtime = createRuntime({ name: "notes", document, create: notesService })
    await runtime.fetch(
      new Request("http://mock.local/__admin/clock", {
        method: "POST",
        body: JSON.stringify({ set: "2030-01-01T00:00:00Z", freeze: true }),
      }),
    )
    await runtime.fetch(
      new Request("http://mock.local/__admin/clock", {
        method: "POST",
        body: JSON.stringify({ advance: "2h" }),
      }),
    )
    const res = await call(runtime, "POST", "/v1/notes", { body: { text: "t" } })
    const note = (await res.json()) as { at: number }
    expect(new Date(note.at).toISOString()).toBe("2030-01-01T02:00:00.000Z")
  })

  test("a counted fault fires exactly count times on its operation only", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 0, max: 5 }),
        async (count, extra) => {
          const runtime = createRuntime({ name: "notes", document, create: notesService })
          await runtime.fetch(
            new Request("http://mock.local/__admin/faults", {
              method: "POST",
              body: JSON.stringify({
                id: "quota",
                operationId: "notes.create",
                status: 400,
                body: { detail: { error_type: "INVALID_REQUEST", error_message: "full" } },
                count,
              }),
            }),
          )
          const statuses: number[] = []
          for (let i = 0; i < count + extra; i++) {
            statuses.push(
              (await call(runtime, "POST", "/v1/notes", { body: { text: "a" } })).status,
            )
          }
          expect(statuses).toEqual([...Array(count).fill(400), ...Array(extra).fill(200)])
          // Other operations are untouched.
          expect((await call(runtime, "GET", "/v1/notes")).status).toBe(200)
          expect(runtime.metrics.report().faults).toBe(count)
        },
      ),
      { ...params, numRuns: Math.min(params.numRuns ?? 100, 20) },
    )
  })

  test("metrics name operations and report unmatched routes", async () => {
    const runtime = createRuntime({ name: "notes", document, create: notesService })
    await call(runtime, "POST", "/v1/notes", { body: { text: "a" } })
    await call(runtime, "GET", "/v1/notes/note_1")
    await call(runtime, "GET", "/v2/brand-new-sdk-call")
    await call(runtime, "GET", "/v2/brand-new-sdk-call")
    const report = runtime.metrics.report()
    expect(report.byOperation).toMatchObject({ "notes.create 200": 1, "notes.retrieve 200": 1 })
    expect(report.unmatched).toEqual([{ method: "GET", path: "/v2/brand-new-sdk-call", count: 2 }])
  })

  test("an invalid namespace is rejected before it reaches the service", async () => {
    const runtime = createRuntime({ name: "notes", document, create: notesService })
    const res = await call(runtime, "GET", "/v1/notes", { headers: { [NAMESPACE_HEADER]: "a b" } })
    expect(res.status).toBe(400)
    expect(res.headers.get(MOCKINGBIRD_HEADER)).toBe(`notes@${PACKAGE_VERSION}`)
  })

  test("every response names the service, its version and the namespace", async () => {
    const runtime = createRuntime({
      name: "notes",
      document,
      create: notesService,
      version: "9.9.9",
    })
    runtime.faults.add({ id: "f", pathPrefix: "/v1/notes/", status: 503 })
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("/v1/notes", "/v1/notes/x", "/nope", "/health", "/__admin", "/__admin/x"),
        fc.constantFrom("default", "w1"),
        fc.boolean(),
        async (path, namespace, keyed) => {
          const res = await call(runtime, "GET", path, {
            headers: { [NAMESPACE_HEADER]: namespace, ...(keyed ? {} : { "x-key": "" }) },
          })
          expect(res.headers.get(MOCKINGBIRD_HEADER)).toBe(`notes@9.9.9; ns=${namespace}`)
        },
      ),
      params,
    )
  })

  test("the journal keeps the last requests per namespace, with the ids a service notes", async () => {
    const annotated = (context: InstanceContext) => {
      const inner = notesService(context)
      return {
        reset: inner.reset,
        fetch: async (request: Request) => {
          const response = await inner.fetch(request)
          return annotateResponse(response, { ids: { noteId: "note_1" }, adopted: true })
        },
      }
    }
    const runtime = createRuntime({ name: "notes", document, create: annotated, journalSize: 2 })
    for (const text of ["a", "b", "c"]) await call(runtime, "POST", "/v1/notes", { body: { text } })
    await call(runtime, "GET", "/v1/notes", { headers: { [NAMESPACE_HEADER]: "other" } })
    const res = await call(runtime, "GET", "/__admin/requests")
    const { requests, size } = (await res.json()) as {
      requests: Record<string, unknown>[]
      size: number
    }
    expect(size).toBe(2)
    expect(requests).toHaveLength(2)
    expect(requests.every((entry) => entry.operationId === "notes.create")).toBe(true)
    expect(requests[0]?.ids).toEqual({ noteId: "note_1" })
    expect(requests[0]?.adopted).toBe(true)
    const everywhere = await call(runtime, "GET", "/__admin/requests?all=1")
    expect(((await everywhere.json()) as { requests: unknown[] }).requests).toHaveLength(3)
  })

  test("a journal ring keeps the newest entries in arrival order", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 0, max: 20 }),
        (size, count) => {
          const journal = createJournal(size)
          for (let i = 0; i < count; i++) {
            journal.record({
              service: "s",
              namespace: "n",
              operationId: String(i),
              method: "GET",
              path: "/",
              status: 200,
              durationMs: 0,
              unmatched: false,
              at: new Date(i).toISOString(),
            })
          }
          const kept = journal.list({ namespace: "n" }).map((entry) => Number(entry.operationId))
          const expected = Array.from({ length: count }, (_, i) => i).slice(
            size === 0 ? count : -size,
          )
          expect(kept).toEqual(expected)
          expect(
            journal.list({ namespace: "n", since: 3 }).every((e) => Date.parse(e.at) >= 3),
          ).toBe(true)
        },
      ),
      params,
    )
  })
})
