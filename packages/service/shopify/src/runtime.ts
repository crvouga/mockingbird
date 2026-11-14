import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  createWebhookHub,
  type FaultPreset,
  hmac,
  type MockControls,
  type RequestLog,
  type ServiceRuntime,
  signers,
  type WebhookEndpoint,
  type WebhookHub,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import {
  cancelOrder,
  fulfillOrder,
  parseGid,
  restFulfillment,
  restOrder,
  restTopic,
  type ShopifyTopic,
  updateFulfillment,
} from "./graph.js"
import { accessTokenOf, SHOPIFY_NAMESPACE, ShopifyAPI, shopifyTimestamp } from "./index.js"
import type { MutationFailure, Settings, TrackingInfo } from "./state.js"

/** `X-Shopify-Hmac-Sha256`: base64 HMAC-SHA256 of the raw body under the app's client secret. */
export const signWebhook = (secret: string, body: string): Promise<string> =>
  hmac("SHA-256", secret, body, "base64")

/**
 * Shopify's failure modes, switched on with `POST /__admin/faults {"preset": "<name>"}` (add
 * `count` to limit them). `POST /__admin/fail-next-mutation` fails exactly the next mutation.
 */
export const SHOPIFY_PRESETS: Record<string, FaultPreset> = {
  throttled: {
    description:
      "GraphQL answers HTTP 200 with errors[{message: 'Throttled', extensions: {code: 'THROTTLED'}}]",
    rules: [{ operationId: "AdminGraphql", effect: "throttled" }],
  },
  invalid_access_token: {
    description: "Admin API calls answer 401 with Shopify's invalid access token error",
    rules: [
      {
        operationId: "AdminGraphql",
        status: 401,
        body: {
          errors: "[API] Invalid API key or access token (unrecognized login or wrong password)",
        },
      },
    ],
  },
  server_error: {
    description: "Admin API calls answer HTTP 500",
    rules: [
      {
        operationId: "AdminGraphql",
        status: 500,
        body: { errors: "Internal Server Error" },
      },
    ],
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

export type ShopifyRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
  settings?: Partial<Settings>
  /** Webhook delivery: retry schedule and the transport receivers are called with. */
  webhooks?: {
    retryDelaysMs?: readonly number[]
    fetch?: (request: Request) => Promise<Response>
  }
}

export type ShopifyRuntime = ServiceRuntime<ShopifyAPI> & { readonly webhooks: WebhookHub }

/** Hub endpoint ids that mirror a GraphQL webhook subscription. */
const SUBSCRIPTION_ENDPOINT = "shopify_subscription_"

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value: unknown) => (typeof value === "string" ? value : null)

/** A numeric id or a `gid://shopify/<type>/<id>` (URL-encoded in a path). */
const idParam = (raw: unknown, type: string): string => {
  const value = decodeURIComponent(String(raw ?? ""))
  const parsed = parseGid(value)
  return parsed?.type === type ? parsed.id : value
}

const trackingOf = (body: Record<string, unknown>): TrackingInfo | undefined => {
  const company = text(body.trackingCompany)
  const number = text(body.trackingNumber)
  const url = text(body.trackingUrl)
  return company || number || url ? { company, number, url } : undefined
}

const FULFILLMENT_DISPLAY_STATUSES = [
  "ATTEMPTED_DELIVERY",
  "CONFIRMED",
  "DELIVERED",
  "FAILURE",
  "FULFILLED",
  "IN_TRANSIT",
  "LABEL_PRINTED",
  "LABEL_PURCHASED",
  "OUT_FOR_DELIVERY",
  "READY_FOR_PICKUP",
]

const CANCEL_REASONS = ["CUSTOMER", "DECLINED", "FRAUD", "INVENTORY", "STAFF", "OTHER"]

const adminRoutes = (runtime: ServiceRuntime<ShopifyAPI>): AdminRoutes => {
  const at = (namespace: string) => shopifyTimestamp(runtime.namespaceClock(namespace).now())
  const emitter = (api: ShopifyAPI) => (topic: ShopifyTopic, body: Record<string, unknown>) =>
    api.emit(topic, body)
  return {
    "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
    "PUT /settings": ({ namespace, body }) => {
      if (!isRecord(body)) return adminError(400, "expected a JSON object")
      const patch: Partial<Settings> = {}
      if (body.accessTokens !== undefined) {
        if (!Array.isArray(body.accessTokens)) return adminError(400, "accessTokens: string[]")
        patch.accessTokens = body.accessTokens.map(String)
      }
      for (const key of ["apiSecret", "shopName", "shopDomain", "currency", "appId"] as const) {
        if (body[key] === undefined) continue
        if (typeof body[key] !== "string" || body[key] === "") {
          return adminError(400, `${key}: non-empty string`)
        }
        patch[key] = body[key] as string
      }
      return json(200, runtime.instance(namespace).state.update(patch))
    },
    "GET /orders/:id": ({ namespace, params }) => {
      const api = runtime.instance(namespace)
      const id = idParam(params.id, "Order")
      const order = api.state.orders.get(id)
      return order
        ? json(200, { order: restOrder(order, api.state.fulfillmentsOf(id)) })
        : adminError(404, `no order ${id}`)
    },
    "POST /orders/:id/fulfill": ({ namespace, params, body }) => {
      const api = runtime.instance(namespace)
      const tracking = (isRecord(body) ? trackingOf(body) : undefined) ?? {
        company: null,
        number: null,
        url: null,
      }
      const result = fulfillOrder(
        api.state,
        idParam(params.id, "Order"),
        tracking,
        at(namespace),
        emitter(api),
      )
      if (typeof result === "string")
        return adminError(result.startsWith("no ") ? 404 : 409, result)
      return json(200, {
        order: restOrder(result.order, api.state.fulfillmentsOf(result.order.id)),
        fulfillment: restFulfillment(result.fulfillment, result.order),
      })
    },
    "POST /orders/:id/cancel": ({ namespace, params, body }) => {
      const reason = isRecord(body) && body.reason !== undefined ? body.reason : "OTHER"
      if (typeof reason !== "string" || !CANCEL_REASONS.includes(reason)) {
        return adminError(400, `reason: one of ${CANCEL_REASONS.join(", ")}`)
      }
      const api = runtime.instance(namespace)
      const result = cancelOrder(
        api.state,
        idParam(params.id, "Order"),
        reason,
        at(namespace),
        emitter(api),
      )
      if (typeof result === "string")
        return adminError(result.startsWith("no ") ? 404 : 409, result)
      return json(200, { order: restOrder(result, api.state.fulfillmentsOf(result.id)) })
    },
    "POST /fulfillments/:id/update": ({ namespace, params, body }) => {
      if (!isRecord(body)) return adminError(400, "expected a JSON object")
      const displayStatus = body.displayStatus
      if (
        displayStatus !== undefined &&
        (typeof displayStatus !== "string" || !FULFILLMENT_DISPLAY_STATUSES.includes(displayStatus))
      ) {
        return adminError(400, `displayStatus: one of ${FULFILLMENT_DISPLAY_STATUSES.join(", ")}`)
      }
      const tracking = trackingOf(body)
      const api = runtime.instance(namespace)
      const result = updateFulfillment(
        api.state,
        idParam(params.id, "Fulfillment"),
        {
          ...(tracking ? { tracking } : {}),
          ...(typeof displayStatus === "string" ? { displayStatus } : {}),
        },
        at(namespace),
        emitter(api),
      )
      if (typeof result === "string") return adminError(404, result)
      const order = api.state.orders.get(result.orderId)
      return json(200, { fulfillment: order ? restFulfillment(result, order) : result })
    },
    "POST /fail-next-mutation": ({ namespace, body }) => {
      if (!isRecord(body) || (body.kind !== "userErrors" && body.kind !== "throttled")) {
        return adminError(
          400,
          'expected {"kind": "userErrors", "message"?, "field"?: string[], "code"?} or {"kind": "throttled"}',
        )
      }
      if (body.field !== undefined && !Array.isArray(body.field)) {
        return adminError(400, "field: string[]")
      }
      const failure: MutationFailure =
        body.kind === "throttled"
          ? { kind: "throttled" }
          : {
              kind: "userErrors",
              message: text(body.message) ?? "Something went wrong",
              field: Array.isArray(body.field) ? body.field.map(String) : null,
              code: text(body.code),
            }
      runtime.instance(namespace).state.mutationFailures.insert("next", failure)
      return json(201, failure)
    },
  }
}

/**
 * The Shopify Admin GraphQL emulator with Mockingbird's full service contract: namespaces by
 * header, by `/__admin/ns/<name>` path prefix or by access token (`PUT /__admin/credentials`),
 * clock control, fault presets, a request journal, and webhooks delivered to the store's own
 * GraphQL webhook subscriptions, signed with `X-Shopify-Hmac-Sha256`.
 */
export const createRuntime = (options: ShopifyRuntimeOptions = {}): ShopifyRuntime => {
  const hub = createWebhookHub({
    signer: signers.custom(async ({ body, secret, type, messageId, tags }) => ({
      "X-Shopify-Topic": type,
      "X-Shopify-Webhook-Id": messageId,
      ...(tags.eventId ? { "X-Shopify-Event-Id": tags.eventId } : {}),
      ...(tags.triggeredAt ? { "X-Shopify-Triggered-At": tags.triggeredAt } : {}),
      ...(secret ? { "X-Shopify-Hmac-Sha256": await signWebhook(secret, body) } : {}),
    })),
    ...(options.webhooks?.retryDelaysMs ? { retryDelaysMs: options.webhooks.retryDelaysMs } : {}),
    ...(options.webhooks?.fetch ? { fetch: options.webhooks.fetch } : {}),
  })
  /** Mirror a namespace's webhook subscriptions into the hub, keeping admin-added endpoints. */
  const sync = (namespace: string, api: ShopifyAPI) => {
    const settings = api.state.current()
    const own = hub
      .endpoints(namespace)
      .filter((endpoint) => !endpoint.id?.startsWith(SUBSCRIPTION_ENDPOINT))
    const subscriptions: WebhookEndpoint[] = api.state.webhookSubscriptions
      .list({ order: "oldest" })
      .map(({ value }) => ({
        id: `${SUBSCRIPTION_ENDPOINT}${value.id}`,
        url: value.uri,
        events: [restTopic(value.topic)],
        secret: settings.apiSecret,
        tags: { subscription: value.id },
        headers: {
          "X-Shopify-Shop-Domain": settings.shopDomain,
          "X-Shopify-API-Version": value.apiVersion,
        },
      }))
    hub.setEndpoints(namespace, [...own, ...subscriptions])
  }
  const runtime = createServiceRuntime<ShopifyAPI>({
    name: SHOPIFY_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix !== undefined ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: accessTokenOf,
    presets: SHOPIFY_PRESETS,
    webhooks: hub,
    create: ({ sqlite, namespace, publicNamespace, clock }) => {
      const api: ShopifyAPI = new ShopifyAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.settings ? { settings: options.settings } : {}),
        onSubscriptionsChanged: () => sync(publicNamespace, api),
        onWebhook: (topic, body) => {
          sync(publicNamespace, api)
          const endpoints = hub.endpoints(publicNamespace)
          const subscriptions = api.state.webhookSubscriptions
            .list({ where: (row) => restTopic(row.topic) === topic, order: "oldest" })
            .map((row) => row.value)
          const listening = endpoints.some(
            (e) =>
              !e.id?.startsWith(SUBSCRIPTION_ENDPOINT) &&
              (!e.events || e.events.includes("*") || e.events.includes(topic)),
          )
          // Publish nothing (so no webhook fault is spent) when nobody listens for the topic.
          if (subscriptions.length === 0 && !listening) return
          const tags = {
            eventId: api.state.nextId("event"),
            triggeredAt: new Date(clock.now()).toISOString(),
          }
          // One message per subscription, so each carries only its `includeFields`.
          for (const subscription of subscriptions) {
            const fields = subscription.includeFields
            hub.publish({
              namespace: publicNamespace,
              type: topic,
              body:
                fields.length === 0
                  ? body
                  : Object.fromEntries(
                      Object.entries(body).filter(([key]) => fields.includes(key)),
                    ),
              tags: { ...tags, subscription: subscription.id },
            })
          }
          if (subscriptions.length === 0) {
            hub.publish({ namespace: publicNamespace, type: topic, body, tags })
          }
        },
      })
      return api
    },
    describe: () => ({ webhooks: "subscriptions" }),
    admin: adminRoutes,
  })
  return Object.assign(runtime, { webhooks: hub })
}
