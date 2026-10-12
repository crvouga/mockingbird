import {
  type AdminRoutes,
  bearerToken,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  type MockControls,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import { document } from "./generated/openapi.js"
import { VercelBlobAPI, type VercelBlobAPIOptions } from "./index.js"
export const VERCEL_BLOB_PRESETS: Record<string, FaultPreset> = {
  conflict: {
    description: "Reject an upload with the vendor duplicate-path response",
    rules: [{ count: 1, operationId: "PutBlob", effect: "conflict" }],
  },
  rate_limited: {
    description: "Reject a request with vendor 429 and Retry-After",
    rules: [
      {
        count: 1,
        status: 429,
        headers: { "Retry-After": "1" },
        body: { error: { code: "rate_limited", message: "Too many requests" } },
      },
    ],
  },
  truncated_upload: {
    description: "Reject a truncated upload before publishing bytes",
    rules: [{ count: 1, operationId: "PutBlob", effect: "truncated_upload" }],
  },
  partial_multipart: {
    description: "Reject one multipart part; earlier parts stay pending",
    rules: [{ count: 1, operationId: "MultipartUpload", effect: "partial_multipart" }],
  },
  server_error: {
    description: "Reject one request with a vendor service error",
    rules: [
      {
        count: 1,
        status: 503,
        body: { error: { code: "service_unavailable", message: "Service unavailable" } },
      },
    ],
  },
  network_reset: {
    description: "Drop one request before any write",
    rules: [{ count: 1, drop: true }],
  },
}
export type VercelBlobRuntimeOptions = Omit<
  VercelBlobAPIOptions,
  "now" | "namespace" | "publicNamespace"
> & {
  clock?: Clock
  seed?: number | string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
}
export type VercelBlobRuntime = ServiceRuntime<VercelBlobAPI>
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const adminError = (status: number, message: string) =>
  Response.json({ error: { type: "mockingbird_admin", message } }, { status })
const routes = (runtime: VercelBlobRuntime): AdminRoutes => ({
  "GET /store/blobs": ({ namespace }) => {
    const api = runtime.instance(namespace)
    return Response.json({ blobs: api.state.blobs.list().map(({ value }) => api.metadata(value)) })
  },
  "POST /store/blobs": ({ namespace, body }) => {
    try {
      const api = runtime.instance(namespace)
      return Response.json(api.metadata(api.seed(body as Parameters<VercelBlobAPI["seed"]>[0])), {
        status: 201,
      })
    } catch {
      return adminError(400, "Invalid blob fixture")
    }
  },
  "GET /store/blobs/:id/bytes": ({ namespace, params }) => {
    const blob = runtime.instance(namespace).state.blobs.get(params.id ?? "")
    return blob
      ? Response.json({ id: blob.id, bytes: blob.bytes })
      : adminError(404, "Unknown blob")
  },
  "GET /store/uploads": ({ namespace }) => {
    const api = runtime.instance(namespace)
    return Response.json({
      uploads: api.state.uploads.list().map(({ value: u }) => ({
        id: u.id,
        storeId: u.storeId,
        pathname: u.pathname,
        key: u.key,
        status: u.status,
        parts: api.state.parts
          .list()
          .filter(({ value: p }) => p.uploadId === u.id)
          .map(({ value: p }) => ({
            partNumber: p.partNumber,
            size: p.bytes.length,
            etag: p.etag,
          })),
      })),
    })
  },
  "POST /store/origin": ({ namespace, body }) => {
    const data = object(body)
    if (typeof data.origin !== "string") return adminError(400, "origin is required")
    let origin: string
    try {
      const url = new URL(data.origin)
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid origin")
      origin = url.origin
    } catch {
      return adminError(400, "Invalid origin")
    }
    runtime.instance(namespace).state.settings.update("current", { initialized: true, origin })
    return Response.json({ origin })
  },
  "POST /store/downloads": ({ namespace, body }) => {
    const data = object(body)
    const api = runtime.instance(namespace)
    const blob = api.state.blobs.get(typeof data.blobId === "string" ? data.blobId : "")
    if (!blob) return adminError(404, "Unknown blob")
    const ttl = data.expiresInMs
    if (typeof ttl !== "number" || !Number.isSafeInteger(ttl) || ttl < 0)
      return adminError(400, "expiresInMs must be a nonnegative integer")
    const id = api.state.ids.next("download_", 24)
    const expiresAt = runtime.namespaceClock(namespace).now() + ttl
    api.state.grants.insert(id, { id, blobId: blob.id, expiresAt })
    const url = new URL(blob.downloadUrl)
    url.searchParams.set("grant", id)
    return Response.json({ id, url: url.toString(), expiresAt }, { status: 201 })
  },
  "POST /store/downloads/:id/expire": ({ namespace, params }) => {
    const api = runtime.instance(namespace)
    const grant = api.state.grants.get(params.id ?? "")
    if (!grant) return adminError(404, "Unknown download")
    api.state.grants.update(grant.id, {
      ...grant,
      expiresAt: runtime.namespaceClock(namespace).now(),
    })
    return Response.json({ id: grant.id, expired: true })
  },
})
export const createRuntime = (options: VercelBlobRuntimeOptions = {}): VercelBlobRuntime =>
  createServiceRuntime({
    name: "vercel-blob",
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix !== undefined ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    create: ({ sqlite, namespace, publicNamespace, clock }) =>
      new VercelBlobAPI({ ...options, sqlite, namespace, publicNamespace, now: clock.now }),
    credential: bearerToken,
    presets: VERCEL_BLOB_PRESETS,
    admin: routes,
  })
