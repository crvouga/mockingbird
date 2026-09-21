import {
  type AdminRoutes,
  bearerToken,
  type Clock,
  createRuntime as createServiceRuntime,
  createWebhookHub,
  extractLinks,
  type FaultPreset,
  outboxAdminRoutes,
  type RequestLog,
  type ServiceRuntime,
  signers,
  type WebhookEndpoint,
  type WebhookHub,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import { type InboundInput, RESEND_NAMESPACE, ResendAPI } from "./index.js"
import type { SentEmail } from "./state.js"

/**
 * Every named Resend misbehaviour our consumer branches on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it). The SDK turns each
 * into its `{data: null, error}` result (it never throws).
 */
export const RESEND_PRESETS: Record<string, FaultPreset> = {
  send_422: {
    description:
      "Send answers 422 validation_error (the SDK returns it as error; sendEmail throws)",
    rules: [
      {
        operationId: "SendEmail",
        status: 422,
        body: {
          statusCode: 422,
          name: "validation_error",
          message:
            "Invalid `to` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.",
        },
      },
    ],
  },
  send_429: {
    description: "Send answers 429 rate_limit_exceeded, with Resend's rate-limit headers",
    rules: [
      {
        operationId: "SendEmail",
        status: 429,
        headers: {
          "retry-after": "1",
          "ratelimit-limit": "2",
          "ratelimit-remaining": "0",
          "ratelimit-reset": "1",
        },
        body: {
          statusCode: 429,
          name: "rate_limit_exceeded",
          message:
            "Too many requests. You can only make 2 requests per second. See rate limit response headers for more information. Or contact support to increase rate limit.",
        },
      },
    ],
  },
  send_500: {
    description: "Send answers a JSON 500 internal_server_error",
    rules: [
      {
        operationId: "SendEmail",
        status: 500,
        body: {
          statusCode: 500,
          name: "internal_server_error",
          message: "An unexpected error occurred.",
        },
      },
    ],
  },
  non_json_500: {
    description: "Send answers a 500 HTML page (the SDK reports application_error)",
    rules: [
      {
        operationId: "SendEmail",
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: "<html><head><title>500 Internal Server Error</title></head><body><h1>Internal Server Error</h1></body></html>",
      },
    ],
  },
  network_drop: {
    description:
      "Send drops the connection before answering (the SDK reports 'Unable to fetch data')",
    rules: [{ operationId: "SendEmail", drop: true }],
  },
  receiving_500: {
    description:
      "The received-email endpoints answer 500 (our hydration throws 'could not be retrieved')",
    rules: [
      {
        pathPrefix: "/emails/receiving",
        status: 500,
        body: {
          statusCode: 500,
          name: "internal_server_error",
          message: "An unexpected error occurred.",
        },
      },
    ],
  },
  webhook_duplicate: {
    description: "The next email.received webhook is delivered twice",
    webhook: { mode: "duplicate" },
  },
  webhook_reorder: {
    description: "The next two email.received webhooks arrive swapped",
    webhook: { mode: "reorder" },
  },
  webhook_drop: {
    description: "The next email.received webhook is never delivered",
    webhook: { mode: "drop" },
  },
}

/** Where sent emails are copied: the Mailosaur mock's `POST /__admin/ingest`. */
export type ForwardTarget = {
  /** The Mailosaur mock's base URL, e.g. `http://127.0.0.1:8793`. */
  url: string
  /** Its `x-mockingbird-admin-key`, when it has one. */
  adminKey?: string
  /** Give up on a forward after this long (the send still succeeds). Default 2000 ms. */
  timeoutMs?: number
  fetch?: (request: Request) => Promise<Response>
}

export type ForwardStats = { forwarded: number; failed: number; lastError: string | null }

/**
 * Copy one sent email into the Mailosaur mock's inbox under the same namespace name, so a test
 * reads codes and links through the Mailosaur SDK. Resolves `true` when the inbox took it.
 */
export const forwardToInbox = async (
  target: ForwardTarget,
  email: SentEmail,
  namespace: string,
): Promise<boolean> => {
  const send = target.fetch ?? ((request: Request) => fetch(request))
  const response = await send(
    new Request(`${target.url.replace(/\/$/, "")}/__admin/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mockingbird-namespace": namespace,
        ...(target.adminKey ? { "x-mockingbird-admin-key": target.adminKey } : {}),
      },
      body: JSON.stringify({
        from: email.from,
        to: email.toHeader,
        cc: email.cc,
        bcc: email.bcc,
        subject: email.subject,
        html: email.html,
        text: email.text,
        headers: email.headers,
      }),
      signal: AbortSignal.timeout(target.timeoutMs ?? 2_000),
    }),
  )
  await response.body?.cancel()
  return response.ok
}

export type ResendRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  /**
   * Where `email.received` webhooks go (`POST /messaging/inbound/email`), signed with the
   * endpoint's `whsec_…` secret the Svix way (`svix-id`, `svix-timestamp`, `svix-signature`).
   */
  webhooks?: Omit<WebhookEndpoint, "id"> & {
    retryDelaysMs?: readonly number[]
    fetch?: (request: Request) => Promise<Response>
  }
  /** Copy every accepted send into a Mailosaur mock (`--forward-to-inbox`). */
  forwardToInbox?: ForwardTarget
}

export type ResendRuntime = ServiceRuntime<ResendAPI> & {
  readonly webhooks: WebhookHub
  /** Forwarding counters, when `forwardToInbox` is set. */
  forwarding(): ForwardStats
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const isAddressList = (value: unknown) =>
  typeof value === "string" || (Array.isArray(value) && value.every((v) => typeof v === "string"))

const inboundInput = (body: unknown): InboundInput | string => {
  if (!isRecord(body)) return "expected a JSON object"
  if (typeof body.from !== "string" || body.from === "") return "from: the sender address"
  if (!isAddressList(body.to) || (Array.isArray(body.to) && body.to.length === 0)) {
    return "to: a recipient address or a non-empty list of them"
  }
  for (const key of ["cc", "bcc", "replyTo"]) {
    if (body[key] !== undefined && !isAddressList(body[key])) return `${key}: an address or a list`
  }
  for (const key of ["subject", "text", "html", "messageId"]) {
    if (body[key] !== undefined && body[key] !== null && typeof body[key] !== "string") {
      return `${key}: a string`
    }
  }
  if (body.headers !== undefined && !isRecord(body.headers)) return "headers: {name: value}"
  if (body.attachments !== undefined) {
    if (
      !Array.isArray(body.attachments) ||
      body.attachments.some(
        (a) => !isRecord(a) || typeof a.filename !== "string" || typeof a.content !== "string",
      )
    ) {
      return "attachments: [{filename, content (base64), contentType?, contentId?}]"
    }
  }
  return body as unknown as InboundInput
}

const adminRoutes =
  (hub: WebhookHub) =>
  (runtime: ServiceRuntime<ResendAPI>): AdminRoutes => ({
    ...outboxAdminRoutes(
      runtime,
      (api) => api.state.outbox,
      (params) => {
        const tag = params.get("tag")
        if (tag === null) return undefined
        const colon = tag.indexOf(":")
        const name = colon < 0 ? tag : tag.slice(0, colon)
        const value = colon < 0 ? undefined : tag.slice(colon + 1)
        return (item) =>
          ((item.tags ?? []) as { name: string; value: string }[]).some(
            (t) => t.name === name && (value === undefined || t.value === value),
          )
      },
    ),
    "GET /outbox/:id/links": ({ params, namespace }) => {
      const email = runtime.instance(namespace).state.outbox.get(params.id as string)
      if (!email) return adminError(404, `no email ${params.id}`)
      const links = email.html
        ? extractLinks(email.html)
        : [...(email.text ?? "").matchAll(/\bhttps?:\/\/[^\s<>"')\]]+/g)].map((m) => m[0])
      return json(200, { id: email.id, links })
    },
    "POST /inbound": ({ body, namespace, url }) => {
      const input = inboundInput(body)
      if (typeof input === "string") return adminError(400, input)
      const { email, event } = runtime.instance(namespace).receive(input, url.origin)
      const message = hub.publish({
        namespace,
        type: event.type,
        body: event,
        id: `msg_${email.id.replace(/-/g, "")}`,
      })
      return json(201, { id: email.id, webhook: message.id, event })
    },
    "GET /inbound": ({ namespace }) => json(200, { emails: runtime.instance(namespace).inbound() }),
  })

/**
 * The Resend mock with Mockingbird's full service contract: `/health`, `/__admin/*`,
 * namespaces by header, by `/ns/<name>` path prefix, or by API key
 * (`PUT /__admin/credentials {"credentials": {"<RESEND_API_KEY>": "<namespace>"}}`),
 * clock control, fault presets, an outbox, Svix-signed inbound webhooks and a request journal.
 */
export const createRuntime = (options: ResendRuntimeOptions = {}): ResendRuntime => {
  const { retryDelaysMs, fetch: send, ...endpoint } = options.webhooks ?? { url: "" }
  const hub = createWebhookHub({
    signer: signers.svix(),
    ...(retryDelaysMs ? { retryDelaysMs } : {}),
    ...(send ? { fetch: send } : {}),
    endpoints: options.webhooks ? [endpoint as WebhookEndpoint] : [],
  })
  const stats: ForwardStats = { forwarded: 0, failed: 0, lastError: null }
  const target = options.forwardToInbox
  const runtime = createServiceRuntime<ResendAPI>({
    name: RESEND_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: bearerToken,
    presets: RESEND_PRESETS,
    webhooks: hub,
    create: ({ sqlite, namespace, publicNamespace, clock }) =>
      new ResendAPI({
        sqlite,
        namespace,
        publicNamespace,
        now: clock.now,
        ...(target
          ? {
              onSent: async (email: SentEmail) => {
                try {
                  if (await forwardToInbox(target, email, publicNamespace)) stats.forwarded++
                  else {
                    stats.failed++
                    stats.lastError = "the inbox refused the message"
                  }
                } catch (error) {
                  stats.failed++
                  stats.lastError = error instanceof Error ? error.message : String(error)
                }
              },
            }
          : {}),
      }),
    describe: () => ({
      webhooks: hub.endpoints("default").length > 0 ? "on" : "off",
      forwardToInbox: target ? target.url : "off",
    }),
    admin: (base) => ({
      ...adminRoutes(hub)(base),
      "GET /forwarding": () => json(200, { target: target?.url ?? null, ...stats }),
    }),
  })
  return Object.assign(runtime, { webhooks: hub, forwarding: () => ({ ...stats }) })
}
