/**
 * A mock with one of everything an admin control can act on: records, generated ids, a
 * clock that stamps them, and a random stream. Shared by the admin controls test files.
 */
import { type OpenAPIDocument, parseOpenAPIDocument } from "@crvouga/mockingbird-openapi"
import {
  CONTROL_HEADERS,
  Collection,
  createRuntime,
  createService,
  faultEffect,
  IdSequence,
  type InstanceContext,
  jsonRes,
  type RuntimeOptions,
  type ServiceInstance,
} from "./src/index.js"

const document: OpenAPIDocument = parseOpenAPIDocument({
  openapi: "3.1.0",
  info: { title: "notes", version: "1" },
  paths: {
    "/v1/notes": {
      post: { operationId: "notes.create", responses: { "200": { description: "ok" } } },
      get: { operationId: "notes.list", responses: { "200": { description: "ok" } } },
    },
    "/v1/notes/{id}": {
      get: {
        operationId: "notes.get",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "ok" } },
      },
    },
    "/v1/essay": {
      get: { operationId: "notes.essay", responses: { "200": { description: "ok" } } },
    },
  },
})

export type Note = { id: string; text: string; createdAt: string; lucky: number }

export const T0 = Date.parse("2030-01-01T00:00:00.000Z")

/** A mock with one of everything a control can act on: records, ids, a clock and a random stream. */
export const mock = (
  extra: Partial<RuntimeOptions<ServiceInstance>> & { slept?: number[] } = {},
): ReturnType<typeof createRuntime<ServiceInstance>> => {
  const { slept, ...options } = extra
  return createRuntime<ServiceInstance>({
    name: "notes",
    document,
    // Never really wait: a test reads what the mock asked to sleep for.
    io: {
      sleep: async (ms) => {
        slept?.push(ms)
      },
    },
    ...options,
    create: (context: InstanceContext) => {
      const notes = new Collection<Note>(context.sqlite, context.namespace, "notes")
      const ids = new IdSequence(context.sqlite, context.namespace)
      return createService({
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
            const note: Note = {
              id: ids.next("note_"),
              text: faultEffect(request, "shout")
                ? String(value.text).toUpperCase()
                : String(value.text),
              createdAt: new Date(context.clock.now()).toISOString(),
              lucky: context.rng.int(0, 1_000_000),
            }
            notes.insert(note.id, note)
            return jsonRes(200, note)
          },
          "notes.list": () =>
            jsonRes(
              200,
              notes.list({ order: "oldest" }).map((row) => row.value),
            ),
          "notes.get": ({ params }) => {
            const found = notes.get(String(params.id))
            return found ? jsonRes(200, found) : jsonRes(404, { detail: "Not Found" })
          },
          "notes.essay": () =>
            new Response("x".repeat(1000), { headers: { "content-type": "text/plain" } }),
        },
      })
    },
  })
}

export type Mock = { fetch(request: Request): Promise<Response> }

export const send = (
  runtime: Mock,
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<Response> =>
  runtime.fetch(
    new Request(`http://mock.local${path}`, {
      method,
      headers: { "content-type": "application/json", ...init.headers },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    }),
  )

export const create = (runtime: Mock, text: string, headers: Record<string, string> = {}) =>
  send(runtime, "POST", "/v1/notes", { body: { text }, headers })
export const list = async (runtime: Mock, headers: Record<string, string> = {}) =>
  (await (await send(runtime, "GET", "/v1/notes", { headers })).json()) as Note[]

export const admin = async <T = Record<string, unknown>>(
  runtime: Mock,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T }> => {
  const response = await send(runtime, method, `/__admin${path}`, {
    ...(body !== undefined ? { body } : {}),
    headers,
  })
  return { status: response.status, body: (await response.json()) as T }
}

export const ns = (name: string) => ({ [CONTROL_HEADERS.namespace]: name })
