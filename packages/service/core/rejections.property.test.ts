import { describe, expect, test } from "bun:test"
import { parseOpenAPIDocument } from "@crvouga/mockingbird-openapi"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import {
  type BodyIssue,
  bodyIssues,
  createRuntime,
  createService,
  type InstanceContext,
  jsonRes,
  type RequestLog,
  unsupportedMediaType,
} from "./src/index.js"

const params = fcParameters(process.env)

const ORDER = {
  type: "object",
  properties: {
    items: {
      type: "array",
      minItems: 1,
      items: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] },
    },
  },
  required: ["items"],
  additionalProperties: false,
}

/**
 * A contract shaped like the ones ASP.NET Core and Spring publish: JSON under several aliases
 * plus a wildcard suffix, a form endpoint whose body is optional, and one with no body at all.
 */
const document = parseOpenAPIDocument({
  openapi: "3.1.0",
  info: { title: "t", version: "1" },
  paths: {
    "/v1/orders": {
      post: {
        operationId: "orders.create",
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: ORDER },
            "text/json": { schema: ORDER },
            "application/*+json": { schema: ORDER },
          },
        },
        responses: { "200": { description: "ok" } },
      },
    },
    "/v1/tokens": {
      post: {
        operationId: "tokens.create",
        requestBody: {
          required: false,
          content: {
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                properties: { grant_type: { type: "string" } },
                required: ["grant_type"],
              },
            },
          },
        },
        responses: { "200": { description: "ok" } },
      },
    },
    "/v1/pings": {
      post: { operationId: "pings.create", responses: { "200": { description: "ok" } } },
    },
  },
})

const ACCEPTED = ["application/json", "text/json", "application/*+json"]

type Answer = {
  issues: BodyIssue[]
  media: { mediaType: string | null; accepted: string[] } | null
}

/** Answers 415 for a body it cannot read, 400 for one the contract rejects, else 200. */
const validating = (context: InstanceContext) => {
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
      "orders.create": (ctx) => {
        const issues = bodyIssues(ctx)
        const media = unsupportedMediaType(ctx) ?? null
        const answer: Answer = { issues, media }
        return jsonRes(media ? 415 : issues.length > 0 ? 400 : 200, answer)
      },
      "tokens.create": (ctx) => {
        const issues = bodyIssues(ctx, "application/x-www-form-urlencoded")
        const answer: Answer = { issues, media: unsupportedMediaType(ctx) ?? null }
        return jsonRes(issues.length > 0 ? 400 : 200, answer)
      },
      "pings.create": (ctx) => {
        const answer: Answer = { issues: bodyIssues(ctx), media: unsupportedMediaType(ctx) ?? null }
        return jsonRes(200, answer)
      },
    },
  })
  return { fetch: service.fetch, reset: service.reset }
}

const send = (
  runtime: { fetch(request: Request): Promise<Response> },
  path: string,
  body: string | undefined,
  contentType: string | undefined,
  headers: Record<string, string> = {},
) =>
  runtime.fetch(
    new Request(`http://mock.local${path}`, {
      method: "POST",
      headers: {
        ...headers,
        ...(contentType === undefined ? {} : { "content-type": contentType }),
        // The client's own length, which the runtime reads without consuming the body.
        ...(body === undefined
          ? {}
          : { "content-length": String(new TextEncoder().encode(body).byteLength) }),
      },
      // Bytes, so no content-type is invented for the request (a string body would be text/plain).
      ...(body === undefined ? {} : { body: new TextEncoder().encode(body) }),
    }),
  )

const VALID = '{"items":[{"sku":"a"}]}'

const acceptedType = fc.constantFrom(
  "application/json",
  "application/json; charset=utf-8",
  "APPLICATION/JSON",
  "text/json",
  "application/vnd.api+json",
  "application/json-patch+json",
)
const unacceptedType = fc.option(
  fc.constantFrom(
    "text/plain",
    "text/plain; charset=utf-8",
    "application/xml",
    "application/x-www-form-urlencoded",
    "application/octet-stream",
    "application/jsonx",
    "application/json+x",
    "multipart/form-data; boundary=x",
    "image/json",
  ),
  { nil: undefined },
)
const essence = (contentType: string | undefined) =>
  contentType?.split(";")[0]?.trim().toLowerCase() ?? null

describe("body media types", () => {
  test("a present body is refused by media type exactly when its content-type matches none the operation lists", async () => {
    const runtime = createRuntime({ name: "shop", document, create: validating })
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          acceptedType.map((type) => ({ type, accepted: true })),
          unacceptedType.map((type) => ({ type, accepted: false })),
        ),
        fc.constantFrom(VALID, '{"items":[]}', "{", "x"),
        async ({ type, accepted }, body) => {
          const res = await send(runtime, "/v1/orders", body, type)
          const answer = (await res.json()) as Answer
          if (accepted) {
            expect(res.status).not.toBe(415)
            expect(answer.media).toBeNull()
            expect(answer.issues.every((issue) => issue.kind !== "media_type")).toBe(true)
          } else {
            expect(res.status).toBe(415)
            expect(answer.media).toEqual({ mediaType: essence(type), accepted: ACCEPTED })
            expect(answer.issues).toEqual([
              {
                path: "",
                kind: "media_type",
                message:
                  type === undefined
                    ? "request body has no content-type"
                    : `request body media type ${essence(type)} is not supported`,
              },
            ])
          }
        },
      ),
      params,
    )
  })

  test("an empty body is `required` and never a media-type problem, whatever the header says; an undeclared body is ignored", async () => {
    const runtime = createRuntime({ name: "shop", document, create: validating })
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(acceptedType, unacceptedType),
        fc.constantFrom(undefined, ""),
        fc.constantFrom(VALID, "{", "grant_type=x", ""),
        async (type, empty, undeclared) => {
          const required = await send(runtime, "/v1/orders", empty, type)
          expect(required.status).toBe(400)
          expect(await required.json()).toEqual({
            issues: [{ path: "", kind: "required", message: "request body is required" }],
            media: null,
          })
          const optional = await send(runtime, "/v1/tokens", empty, type)
          expect(optional.status).toBe(200)
          expect(await optional.json()).toEqual({ issues: [], media: null })
          const ignored = await send(runtime, "/v1/pings", undeclared, type)
          expect(ignored.status).toBe(200)
          expect(await ignored.json()).toEqual({ issues: [], media: null })
        },
      ),
      params,
    )
  })

  test("a body the operation accepts is judged by the contract: malformed is `syntax`, a violation is `schema`, valid passes", async () => {
    const runtime = createRuntime({ name: "shop", document, create: validating })
    await fc.assert(
      fc.asyncProperty(
        acceptedType,
        fc.constantFrom(
          { body: VALID, kinds: [] },
          { body: "{", kinds: ["syntax"] },
          { body: "[1", kinds: ["syntax"] },
          { body: '{"items":[]}', kinds: ["schema"] },
          { body: "{}", kinds: ["schema"] },
          { body: '{"items":[{}],"extra":1}', kinds: ["schema", "schema"] },
        ),
        async (type, { body, kinds }) => {
          const res = await send(runtime, "/v1/orders", body, type)
          const answer = (await res.json()) as Answer
          expect(res.status).toBe(kinds.length > 0 ? 400 : 200)
          expect(answer.media).toBeNull()
          expect(answer.issues.map((issue) => issue.kind)).toEqual([...kinds])
        },
      ),
      params,
    )
    const form = await send(runtime, "/v1/tokens", "scope=x", "application/x-www-form-urlencoded")
    expect(form.status).toBe(400)
    expect(((await form.json()) as Answer).issues.map((issue) => issue.kind)).toEqual(["schema"])
  })
})

describe("rejected requests in the log", () => {
  test("a rejection the mock produced records what arrived and why; a pass and a scripted fault do not", async () => {
    const entries: RequestLog[] = []
    const runtime = createRuntime({
      name: "shop",
      document,
      create: validating,
      onLog: (entry) => entries.push(entry),
    })
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(acceptedType, unacceptedType),
        fc.constantFrom(undefined, "", VALID, '{"items":[]}', "{", "0123456789".repeat(40)),
        fc.boolean(),
        async (type, body, faulted) => {
          if (faulted) {
            const armed = await runtime.fetch(
              new Request("http://mock.local/__admin/faults", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ operationId: "orders.create", status: 503, count: 1 }),
              }),
            )
            expect(armed.status).toBeLessThan(300)
          }
          entries.length = 0
          const res = await send(runtime, "/v1/orders", body, type)
          expect(entries).toHaveLength(1)
          const entry = entries[0] as RequestLog
          expect(entry.status).toBe(res.status)
          if (faulted) {
            expect(res.status).toBe(503)
            expect(entry.faultId).toBeDefined()
            expect(entry.request).toBeUndefined()
            expect(entry.issues).toBeUndefined()
            return
          }
          const answer = (await res.json()) as Answer
          if (res.status < 400) {
            expect(entry.request).toBeUndefined()
            expect(entry.issues).toBeUndefined()
            return
          }
          expect(entry.request).toEqual({
            contentType: type ?? null,
            bodyBytes: body === undefined ? null : new TextEncoder().encode(body).byteLength,
            transferEncoding: null,
          })
          expect(entry.issues).toEqual(answer.issues)
          // The same entry, from the journal.
          const listed = await runtime.fetch(new Request("http://mock.local/__admin/requests"))
          const { requests } = (await listed.json()) as { requests: RequestLog[] }
          expect(requests.at(-1)).toMatchObject({ request: entry.request, issues: entry.issues })
          // Never the body.
          expect(JSON.stringify(entry)).not.toContain(body && body.length > 4 ? body : "\u0000")
        },
      ),
      params,
    )
  })

  test("the runtime does not consume a streamed request body, and reports bodyBytes null without content-length", async () => {
    const entries: RequestLog[] = []
    const runtime = createRuntime({
      name: "shop",
      document,
      create: validating,
      onLog: (entry) => entries.push(entry),
    })
    // A streamed body with no content-length: if the runtime read it to count bytes, the handler
    // would see an empty body. text/plain is unsupported here, so the handler must still 415 it,
    // proving the body reached the handler intact.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(VALID))
        controller.close()
      },
    })
    const res = await runtime.fetch(
      new Request("http://mock.local/v1/orders", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    )
    expect(res.status).toBe(415)
    expect((await res.json()).media).toEqual({ mediaType: "text/plain", accepted: ACCEPTED })
    expect(entries[0]?.request).toEqual({
      contentType: "text/plain",
      bodyBytes: null,
      transferEncoding: null,
    })
  })

  test("a rejection outside any operation (an unknown path) still records what arrived", async () => {
    const entries: RequestLog[] = []
    const runtime = createRuntime({
      name: "shop",
      document,
      create: validating,
      onLog: (entry) => entries.push(entry),
    })
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(acceptedType, unacceptedType),
        fc.constantFrom(undefined, "", VALID),
        async (type, body) => {
          entries.length = 0
          const res = await send(runtime, "/v1/nothing", body, type)
          expect(res.status).toBe(404)
          expect(entries[0]).toMatchObject({
            unmatched: true,
            request: {
              contentType: type ?? null,
              bodyBytes: body === undefined ? null : new TextEncoder().encode(body).byteLength,
              transferEncoding: null,
            },
          })
          expect(entries[0]?.issues).toBeUndefined()
        },
      ),
      params,
    )
  })
})
