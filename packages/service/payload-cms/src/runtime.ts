import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import { PAYLOAD_CMS_NAMESPACE, PayloadCmsAPI, payloadCredential } from "./index.js"
import type { PayloadDoc, Seed } from "./state.js"

/**
 * Every Payload CMS failure our referral-content fallback handles, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it). Each one makes the
 * backend fall back to its default referral content.
 */
export const PAYLOAD_CMS_PRESETS: Record<string, FaultPreset> = {
  server_error: {
    description: "Collection reads answer 500 {errors: [{message}]}",
    rules: [
      {
        pathPrefix: "/api/",
        status: 500,
        body: { errors: [{ message: "Something went wrong." }] },
      },
    ],
  },
  forbidden: {
    description: "Collection reads answer 403 (read access revoked)",
    rules: [
      {
        pathPrefix: "/api/",
        status: 403,
        body: { errors: [{ message: "You are not allowed to perform this action." }] },
      },
    ],
  },
  collection_not_found: {
    description: "Collection reads answer 404 (the marketing collection is missing)",
    rules: [
      {
        pathPrefix: "/api/",
        status: 404,
        body: { errors: [{ message: "The requested resource was not found." }] },
      },
    ],
  },
  no_active_docs: {
    description: "Finds answer an empty page (no active referral content)",
    rules: [{ operationId: "FindDocuments", effect: "no_active_docs" }],
  },
  malformed_json: {
    description: "Finds answer 200 with a body that is not JSON (the JSON parse throws)",
    rules: [
      {
        operationId: "FindDocuments",
        status: 200,
        body: "<!doctype html><title>Payload</title>",
        headers: { "content-type": "text/html" },
      },
    ],
  },
  unavailable: {
    description: "Every call answers a 503 HTML page from the load balancer",
    rules: [
      {
        status: 503,
        body: "<html><body>Service Unavailable</body></html>",
        headers: { "content-type": "text/html" },
      },
    ],
  },
  connection_drop: {
    description: "The connection drops before any answer (fetch rejects)",
    rules: [{ pathPrefix: "/api/", drop: true }],
  },
  slow: {
    description: "Collection reads answer after 10 s",
    rules: [{ pathPrefix: "/api/", latencyMs: 10_000 }],
  },
}

export type PayloadCmsRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  /** Collections every namespace starts with. Default: the marketing collection seed. */
  collections?: Seed
}

export type PayloadCmsRuntime = ServiceRuntime<PayloadCmsAPI>

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const toDocs = (value: unknown, now: string): PayloadDoc[] | string => {
  if (!Array.isArray(value) || !value.every(isRecord)) return "expected {docs: [{…}]}"
  return value.map((doc, index) => ({
    createdAt: now,
    updatedAt: now,
    ...doc,
    id: typeof doc.id === "number" ? doc.id : index + 1,
  }))
}

const adminRoutes = (runtime: ServiceRuntime<PayloadCmsAPI>): AdminRoutes => ({
  "GET /collections": ({ namespace }) =>
    json(200, { collections: runtime.instance(namespace).collections() }),
  "GET /collections/:slug": ({ params, namespace }) => {
    const collection = runtime.instance(namespace).state.get(params.slug as string)
    return collection ? json(200, collection) : adminError(404, `no collection ${params.slug}`)
  },
  "PUT /collections/:slug": ({ params, body, namespace }) => {
    const docs = toDocs(
      isRecord(body) ? body.docs : undefined,
      new Date(runtime.clock.now()).toISOString(),
    )
    if (typeof docs === "string") return adminError(400, docs)
    return json(200, runtime.instance(namespace).state.replace(params.slug as string, docs))
  },
  "POST /collections/:slug/docs": ({ params, body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a document object")
    return json(201, runtime.instance(namespace).addDoc(params.slug as string, body))
  },
  "PATCH /collections/:slug/docs/:id": ({ params, body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a partial document object")
    const doc = runtime
      .instance(namespace)
      .updateDoc(params.slug as string, Number(params.id), body)
    return doc ? json(200, doc) : adminError(404, `no document ${params.slug}/${params.id}`)
  },
  "DELETE /collections/:slug/docs/:id": ({ params, namespace }) =>
    runtime.instance(namespace).deleteDoc(params.slug as string, Number(params.id))
      ? json(200, { deleted: true })
      : adminError(404, `no document ${params.slug}/${params.id}`),
})

/**
 * The Payload CMS mock with Mockingbird's full service contract: `/health`, `/__admin/*`,
 * namespaces by header, by `/ns/<name>` path prefix (on `PAYLOAD_CMS_API_URL`), or by API key
 * / bearer token, clock control, fault presets and a request journal.
 */
export const createRuntime = (options: PayloadCmsRuntimeOptions = {}): PayloadCmsRuntime =>
  createServiceRuntime<PayloadCmsAPI>({
    name: PAYLOAD_CMS_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: payloadCredential,
    presets: PAYLOAD_CMS_PRESETS,
    create: ({ sqlite, namespace, clock }) =>
      new PayloadCmsAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.collections ? { collections: options.collections } : {}),
      }),
    admin: adminRoutes,
  })
