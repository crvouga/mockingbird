import {
  type AdminRoutes,
  type Clock,
  createWebhookHub,
  type FaultPreset,
  type RequestLog,
  type ServiceRuntime,
  createRuntime as serviceRuntime,
  signers,
  type WebhookEndpoint,
  type WebhookHub,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import { accessKeyCredential, S3_NAMESPACE, S3API } from "./index.js"
import type { S3SeedObject } from "./state.js"

export const S3_PRESETS: Record<string, FaultPreset> = {
  slow_down: {
    description: "S3 answers SlowDown for the next matching request",
    rules: [
      {
        status: 503,
        body: "<Error><Code>SlowDown</Code><Message>Please reduce your request rate.</Message></Error>",
        headers: { "content-type": "application/xml" },
      },
    ],
  },
  access_denied: {
    description: "S3 answers AccessDenied",
    rules: [
      {
        status: 403,
        body: "<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>",
        headers: { "content-type": "application/xml" },
      },
    ],
  },
  expired_token: {
    description: "S3 answers ExpiredToken",
    rules: [
      {
        status: 400,
        body: "<Error><Code>ExpiredToken</Code><Message>The provided token has expired.</Message></Error>",
        headers: { "content-type": "application/xml" },
      },
    ],
  },
  truncate_stream: {
    description: "The next matching GetObject returns half of the stored bytes",
    rules: [{ operationId: "GetObject", effect: "truncate_stream", count: 1 }],
  },
}
export type S3RuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  buckets?: readonly string[]
  objects?: readonly S3SeedObject[]
  credentials?: Readonly<Record<string, string>>
  webhooks?: {
    endpoints?: WebhookEndpoint[]
    retryDelaysMs?: readonly number[]
    fetch?: (request: Request) => Promise<Response>
  }
}
export type S3Runtime = ServiceRuntime<S3API> & { readonly webhooks: WebhookHub }
const admin = (runtime: ServiceRuntime<S3API>): AdminRoutes => ({
  "GET /objects": ({ namespace, url }) => {
    const bucket = url.searchParams.get("bucket")
    return Response.json({
      objects: runtime
        .instance(namespace)
        .state.objects.list({ where: (object) => !bucket || object.bucket === bucket })
        .map(({ value }) => ({
          bucket: value.bucket,
          key: value.key,
          contentLength: value.bytes.length,
          contentType: value.contentType,
          etag: value.etag,
          lastModified: value.lastModified,
          metadata: value.metadata,
        })),
    })
  },
  "GET /uploads": ({ namespace }) =>
    Response.json({
      uploads: runtime
        .instance(namespace)
        .state.uploads.list()
        .map(({ value }) => ({
          ...value,
          parts: runtime
            .instance(namespace)
            .state.parts.list({ where: (part) => part.uploadId === value.id })
            .map(({ value: part }) => ({
              partNumber: part.partNumber,
              etag: part.etag,
              contentLength: part.bytes.length,
            })),
        })),
    }),
  "POST /objects": async ({ namespace, body }) => {
    const input = body as {
      bucket?: unknown
      key?: unknown
      body?: unknown
      contentType?: unknown
    } | null
    if (
      !input ||
      typeof input.bucket !== "string" ||
      typeof input.key !== "string" ||
      typeof input.body !== "string"
    )
      return Response.json(
        {
          error: { type: "mockingbird_admin", message: "bucket, key and string body are required" },
        },
        { status: 400 },
      )
    const object = await runtime.instance(namespace).putSeed({
      bucket: input.bucket,
      key: input.key,
      body: input.body,
      metadata: {},
      ...(typeof input.contentType === "string" ? { contentType: input.contentType } : {}),
    })
    return Response.json(
      { bucket: object.bucket, key: object.key, etag: object.etag },
      { status: 201 },
    )
  },
  "GET /objects/:bucket/:key": ({ namespace, params }) => {
    const object = runtime
      .instance(namespace)
      .state.object(params.bucket as string, params.key as string)
    return object
      ? new Response(new Uint8Array(object.bytes), {
          headers: { "content-type": object.contentType ?? "application/octet-stream" },
        })
      : Response.json(
          { error: { type: "mockingbird_admin", message: "object not found" } },
          { status: 404 },
        )
  },
})
export const createRuntime = (options: S3RuntimeOptions = {}): S3Runtime => {
  const hub = createWebhookHub({
    signer: signers.none(),
    endpoints: options.webhooks?.endpoints ?? [],
    ...(options.webhooks?.retryDelaysMs ? { retryDelaysMs: options.webhooks.retryDelaysMs } : {}),
    ...(options.webhooks?.fetch ? { fetch: options.webhooks.fetch } : {}),
  })
  const runtime = serviceRuntime({
    name: S3_NAMESPACE,
    document,
    presets: S3_PRESETS,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: accessKeyCredential,
    create: ({ sqlite, namespace, clock }) =>
      new S3API({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.buckets ? { buckets: options.buckets } : {}),
        ...(options.objects ? { objects: options.objects } : {}),
        ...(options.credentials ? { credentials: options.credentials } : {}),
        onNotification: (event) =>
          hub.publish({
            namespace,
            type: `s3:${event.eventName}`,
            body: {
              Records: [
                {
                  eventName: event.eventName,
                  eventTime: event.occurredAt,
                  s3: {
                    bucket: { name: event.bucket },
                    object: {
                      key: encodeURIComponent(event.key),
                      eTag: event.etag,
                      size: event.size,
                    },
                  },
                },
              ],
            },
          }),
      }),
    admin,
  })
  return Object.assign(runtime, { webhooks: hub })
}
