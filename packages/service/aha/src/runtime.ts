import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  createWebhookHub,
  type FaultPreset,
  type RequestLog,
  type ServiceRuntime,
  signers,
  type WebhookEndpoint,
  type WebhookHub,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import { AHA_NAMESPACE, AhaAPI, apiKeyCredential, type TransitionInput } from "./index.js"
import type { ApiCredential, AutoSchedule, Settings } from "./state.js"

/** Where our backend receives AHA webhooks. */
export const WEBHOOK_PATH = "/bloodwork/aha-webhook"

/**
 * Every named AHA misbehaviour our consumers branch on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it).
 */
export const AHA_PRESETS: Record<string, FaultPreset> = {
  bad_signature: {
    description: "Every call answers 401 Invalid signature (AHA_API_ERROR / upstream)",
    rules: [{ pathPrefix: "/v1/geviti", effect: "bad_signature" }],
  },
  rate_limited: {
    description:
      "Every call answers 429 (the lab-provider client maps it to rate_limit, retryable)",
    rules: [
      {
        pathPrefix: "/v1/geviti",
        status: 429,
        body: { status: "ERROR", message: "Too many requests" },
      },
    ],
  },
  server_error: {
    description: "Every call answers 500",
    rules: [
      {
        pathPrefix: "/v1/geviti",
        status: 500,
        body: { status: "ERROR", message: "Internal server error" },
      },
    ],
  },
  order_error: {
    description:
      "create-order / cancel answer 200 with inner status ERROR (the lab provider fails it; AhaService does not check)",
    rules: [{ pathPrefix: "/v1/geviti", effect: "order_error" }],
  },
  invalid_response: {
    description: "create-order / cancel answer 200 with a body neither client's zod schema accepts",
    rules: [{ pathPrefix: "/v1/geviti", effect: "invalid_response" }],
  },
  webhook_duplicate: {
    description: "The next webhook is delivered twice",
    webhook: { mode: "duplicate" },
  },
  webhook_reorder: {
    description: "The next two webhooks arrive swapped",
    webhook: { mode: "reorder" },
  },
  webhook_drop: {
    description: "The next webhook is never delivered",
    webhook: { mode: "drop" },
  },
}

type WebhookDelivery = {
  retryDelaysMs?: readonly number[]
  fetch?: (request: Request) => Promise<Response>
}

export type AhaRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  settings?: Partial<Settings>
  /**
   * Where webhooks go (`POST /bloodwork/aha-webhook`); `secret` is `AHA_WEBHOOK_SECRET`,
   * sent as `Authorization: Token <secret>`.
   */
  webhooks?: Omit<WebhookEndpoint, "id"> & WebhookDelivery
  /** Wall clock for `X-TIMESTAMP` tolerance. Default `Date.now`. */
  wallClock?: () => number
  /** Run `autoSchedule` on this real-time interval (ms). The served mock uses 100 ms. */
  tickMs?: number
}

export type AhaRuntime = ServiceRuntime<AhaAPI> & {
  readonly webhooks: WebhookHub
  /** Stop the background ticker, if one runs. */
  stop(): void
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseAutoSchedule = (value: unknown): AutoSchedule | null | string => {
  if (value === null) return null
  if (typeof value === "number" && value >= 0) return { afterMs: value }
  if (!isRecord(value) || typeof value.afterMs !== "number" || value.afterMs < 0) {
    return "autoSchedule must be {afterMs, leadMs?}, a number of ms, or null"
  }
  if (value.leadMs !== undefined && typeof value.leadMs !== "number") return "leadMs: number"
  return {
    afterMs: value.afterMs,
    ...(typeof value.leadMs === "number" ? { leadMs: value.leadMs } : {}),
  }
}

const parseCredentials = (value: unknown): ApiCredential[] | string => {
  if (!Array.isArray(value)) return "credentials: [{apiKey, apiSecret?}]"
  const out: ApiCredential[] = []
  for (const each of value) {
    if (!isRecord(each) || typeof each.apiKey !== "string") return "each credential needs apiKey"
    out.push({
      apiKey: each.apiKey,
      ...(typeof each.apiSecret === "string" ? { apiSecret: each.apiSecret } : {}),
    })
  }
  return out
}

/** Settings as `GET /__admin/settings` shows them: secrets masked. */
const visible = (settings: Settings) => ({
  ...settings,
  credentials: settings.credentials.map((c) => ({
    apiKey: c.apiKey,
    ...(c.apiSecret !== undefined ? { apiSecret: "***" } : {}),
  })),
})

const adminRoutes = (runtime: ServiceRuntime<AhaAPI>): AdminRoutes => ({
  "GET /orders": ({ namespace }) => json(200, { orders: runtime.instance(namespace).orders() }),
  "POST /orders/:partnerOrderId/transition": ({ params, body, namespace }) => {
    if (!isRecord(body) || typeof body.status !== "string") {
      return adminError(
        400,
        'expected {"status": "<AHA status>", "drawStatus"?, "scheduledAt"?, "timeZone"?}',
      )
    }
    const input: TransitionInput = { status: body.status }
    if (typeof body.drawStatus === "string") input.drawStatus = body.drawStatus
    if (typeof body.scheduledAt === "string" || typeof body.scheduledAt === "number") {
      input.scheduledAt = body.scheduledAt
    }
    if (typeof body.timeZone === "string") input.timeZone = body.timeZone
    try {
      const moved = runtime.instance(namespace).transition(params.partnerOrderId as string, input)
      return moved ? json(200, moved) : adminError(404, `no order ${params.partnerOrderId}`)
    } catch (err) {
      if (err instanceof RangeError) return adminError(400, err.message)
      throw err
    }
  },
  "GET /settings": ({ namespace }) =>
    json(200, visible(runtime.instance(namespace).state.current())),
  "PUT /settings": ({ body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const patch: Partial<Settings> = {}
    if (body.envelope !== undefined) {
      if (body.envelope !== "raw" && body.envelope !== "wrapped")
        return adminError(400, 'envelope: "raw" | "wrapped"')
      patch.envelope = body.envelope
    }
    if (body.credentials !== undefined) {
      const parsed = parseCredentials(body.credentials)
      if (typeof parsed === "string") return adminError(400, parsed)
      patch.credentials = parsed
    }
    for (const flag of ["allowLegacy", "cancelWebhook"] as const) {
      if (body[flag] !== undefined) {
        if (typeof body[flag] !== "boolean") return adminError(400, `${flag}: boolean`)
        patch[flag] = body[flag]
      }
    }
    if (body.timestampToleranceMs !== undefined) {
      if (typeof body.timestampToleranceMs !== "number")
        return adminError(400, "timestampToleranceMs: number")
      patch.timestampToleranceMs = body.timestampToleranceMs
    }
    if (body.defaultTimeZone !== undefined) {
      if (typeof body.defaultTimeZone !== "string")
        return adminError(400, "defaultTimeZone: IANA zone")
      patch.defaultTimeZone = body.defaultTimeZone
    }
    if (body.autoSchedule !== undefined) {
      const parsed = parseAutoSchedule(body.autoSchedule)
      if (typeof parsed === "string") return adminError(400, parsed)
      patch.autoSchedule = parsed
    }
    return json(200, visible(runtime.instance(namespace).state.update(patch)))
  },
  "POST /tick": ({ namespace }) => json(200, { applied: runtime.instance(namespace).tick() }),
})

/**
 * The AHA mock with Mockingbird's full service contract: `/health`, `/__admin/*`, namespaces
 * by header, by `/ns/<name>` prefix on `AHA_API_URL`, or by API key
 * (`PUT /__admin/credentials {"credentials": {"<AHA_API_KEY>": "<namespace>"}}`), clock
 * control, fault presets, webhooks and a request journal.
 */
export const createRuntime = (options: AhaRuntimeOptions = {}): AhaRuntime => {
  const { retryDelaysMs, fetch: send, ...endpoint } = options.webhooks ?? { url: "" }
  const hub = createWebhookHub({
    signer: signers.header("Authorization", (secret) => `Token ${secret}`),
    ...(retryDelaysMs ? { retryDelaysMs } : {}),
    ...(send ? { fetch: send } : {}),
    endpoints: options.webhooks ? [endpoint as WebhookEndpoint] : [],
  })
  const runtime = createServiceRuntime<AhaAPI>({
    name: AHA_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: apiKeyCredential,
    presets: AHA_PRESETS,
    webhooks: hub,
    create: ({ sqlite, namespace, publicNamespace, clock }) =>
      new AhaAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.wallClock ? { wallClock: options.wallClock } : {}),
        ...(options.settings ? { settings: options.settings } : {}),
        onWebhook: (event) =>
          hub.publish({
            namespace: publicNamespace,
            type: event.status,
            body: event,
          }),
      }),
    describe: () => ({ webhooks: hub.endpoints("default").length > 0 ? "on" : "off" }),
    admin: adminRoutes,
  })
  let timer: ReturnType<typeof setInterval> | undefined
  if (options.tickMs !== undefined && options.tickMs > 0) {
    timer = setInterval(() => {
      for (const name of runtime.namespaces()) runtime.instance(name).tick()
    }, options.tickMs)
    ;(timer as { unref?: () => void }).unref?.()
  }
  return Object.assign(runtime, {
    webhooks: hub,
    stop: () => {
      if (timer !== undefined) clearInterval(timer)
    },
  })
}
