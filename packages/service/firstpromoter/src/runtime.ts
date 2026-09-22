import {
  type AdminRoutes,
  bearerToken,
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
import { FIRSTPROMOTER_NAMESPACE, FirstPromoterAPI } from "./index.js"
import type { Campaign, Settings } from "./state.js"

/** Where our backend receives FirstPromoter webhooks (`users.controller.ts`, Basic auth). */
export const WEBHOOK_PATH = "/users/webhooks/first-promoter"

/**
 * Every named FirstPromoter misbehaviour our consumer branches on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it).
 */
export const FIRSTPROMOTER_PRESETS: Record<string, FaultPreset> = {
  created_but_500: {
    description:
      "Promoter create stores the promoter, then answers 500 (the next attempt must adopt it by cust_id)",
    rules: [{ operationId: "CreatePromoter", effect: "created_but_500" }],
  },
  lookup_unavailable: {
    description: "Promoter lookups answer 503 (our client must neither create nor adopt)",
    rules: [
      {
        operationId: "GetPromoter",
        status: 503,
        body: { message: "Service temporarily unavailable" },
      },
    ],
  },
  no_campaign: {
    description: "Promoters come back with no promoter_campaigns (no ref_link to adopt)",
    rules: [
      { operationId: "GetPromoter", effect: "no_campaign" },
      { operationId: "CreatePromoter", effect: "no_campaign" },
    ],
  },
  unauthorized: {
    description: "Every call answers 401 (a revoked API key)",
    rules: [{ status: 401, body: { message: "Unauthorized" } }],
  },
  rate_limited: {
    description: "Every call answers 429 Too Many Requests",
    rules: [
      {
        status: 429,
        headers: { "retry-after": "1" },
        body: { message: "Too many requests. Please retry later." },
      },
    ],
  },
  server_error: {
    description: "Every call answers 500",
    rules: [{ status: 500, body: { message: "Internal server error" } }],
  },
  connection_drop: {
    description: "The connection drops before a response (our 10 s timeout path)",
    rules: [{ drop: true }],
  },
  webhook_duplicate: {
    description: "The next lead_becomes_referral webhook is delivered twice",
    webhook: { mode: "duplicate" },
  },
  webhook_drop: {
    description: "The next lead_becomes_referral webhook is never delivered",
    webhook: { mode: "drop" },
  },
}

type WebhookHubOptionsSubset = {
  retryDelaysMs?: readonly number[]
  fetch?: (request: Request) => Promise<Response>
}

export type FirstPromoterRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  settings?: Partial<Settings>
  /**
   * Where webhooks go (`POST /users/webhooks/first-promoter`). `secret` is
   * `"<FIRST_PROMOTER_WEBHOOK_AUTH_USERNAME>:<FIRST_PROMOTER_WEBHOOK_AUTH_PASSWORD>"`, sent as
   * `Authorization: Basic <base64>`.
   */
  webhooks?: Omit<WebhookEndpoint, "id"> & WebhookHubOptionsSubset
}

export type FirstPromoterRuntime = ServiceRuntime<FirstPromoterAPI> & {
  readonly webhooks: WebhookHub
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const adminRoutes = (runtime: ServiceRuntime<FirstPromoterAPI>): AdminRoutes => ({
  "GET /promoters": ({ namespace }) =>
    json(200, { promoters: runtime.instance(namespace).state.all() }),
  "POST /promoters": ({ body, namespace }) => {
    if (!isRecord(body) || typeof body.email !== "string") {
      return adminError(400, 'expected {"email", "cust_id"?, "first_name"?, "ref_token"?}')
    }
    const text = (key: string) =>
      typeof body[key] === "string" ? (body[key] as string) : undefined
    const api = runtime.instance(namespace)
    const promoter = api.seedPromoter({
      email: body.email,
      ...(text("cust_id") !== undefined ? { cust_id: text("cust_id") } : {}),
      ...(text("first_name") !== undefined ? { first_name: text("first_name") } : {}),
      ...(text("last_name") !== undefined ? { last_name: text("last_name") } : {}),
      ...(text("ref_token") !== undefined ? { ref_token: text("ref_token") } : {}),
      ...(typeof body.campaign_id === "number" ? { campaign_id: body.campaign_id } : {}),
    })
    return json(201, api.render(promoter))
  },
  "POST /clicks": ({ body, namespace }) => {
    if (!isRecord(body) || typeof body.ref_token !== "string") {
      return adminError(400, 'expected {"ref_token": "<promoter ref token>"}')
    }
    const click = runtime.instance(namespace).click(body.ref_token)
    return click
      ? json(201, click)
      : adminError(404, `no promoter with ref_token ${body.ref_token}`)
  },
  "GET /referrals": ({ namespace }) =>
    json(200, {
      referrals: runtime
        .instance(namespace)
        .state.referrals.list({ order: "oldest" })
        .map((row) => row.value),
    }),
  "POST /referrals/:id/convert": ({ params, body, namespace }) => {
    const amount = isRecord(body) && typeof body.saleAmount === "number" ? body.saleAmount : 0
    const referral = runtime.instance(namespace).convert(Number(params.id), amount)
    return referral ? json(200, referral) : adminError(404, `no attributed referral ${params.id}`)
  },
  "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
  "PUT /settings": ({ body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const patch: Partial<Settings> = {}
    if (typeof body.website === "string") patch.website = body.website
    if (typeof body.defaultCampaignId === "number") patch.defaultCampaignId = body.defaultCampaignId
    if (typeof body.autoConvert === "boolean") patch.autoConvert = body.autoConvert
    if (body.campaigns !== undefined) {
      if (!Array.isArray(body.campaigns)) return adminError(400, "campaigns: Campaign[]")
      patch.campaigns = body.campaigns as Campaign[]
    }
    return json(200, runtime.instance(namespace).state.update(patch))
  },
})

/**
 * The FirstPromoter mock with Mockingbird's full service contract: `/health`, `/__admin/*`,
 * namespaces by header, by `/ns/<name>` path prefix (in `FIRST_PROMOTER_API_URL`), or by API
 * key (`PUT /__admin/credentials {"credentials": {"<FIRST_PROMOTER_API_KEY>": "<namespace>"}}`),
 * clock control, fault presets, Basic-auth webhooks and a request journal.
 */
export const createRuntime = (options: FirstPromoterRuntimeOptions = {}): FirstPromoterRuntime => {
  const { retryDelaysMs, fetch: send, ...endpoint } = options.webhooks ?? { url: "" }
  const hub = createWebhookHub({
    signer: signers.header("authorization", (secret) => `Basic ${btoa(secret)}`),
    ...(retryDelaysMs ? { retryDelaysMs } : {}),
    ...(send ? { fetch: send } : {}),
    endpoints: options.webhooks ? [endpoint as WebhookEndpoint] : [],
  })
  const runtime = createServiceRuntime<FirstPromoterAPI>({
    name: FIRSTPROMOTER_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: bearerToken,
    presets: FIRSTPROMOTER_PRESETS,
    webhooks: hub,
    create: ({ sqlite, namespace, publicNamespace, clock }) =>
      new FirstPromoterAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.settings ? { settings: options.settings } : {}),
        onWebhook: (event) =>
          hub.publish({
            namespace: publicNamespace,
            type: event.event.type,
            body: event,
            id: `fp_evt_${event.event.id}`,
          }),
      }),
    describe: () => ({ webhooks: hub.endpoints("default").length > 0 ? "on" : "off" }),
    admin: adminRoutes,
  })
  return Object.assign(runtime, { webhooks: hub })
}
