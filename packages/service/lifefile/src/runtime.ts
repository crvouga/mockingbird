import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  createWebhookHub,
  type FaultPreset,
  type MockControls,
  type RequestLog,
  type ServiceRuntime,
  signers,
  type WebhookHub,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import { basicUsername, LIFEFILE_NAMESPACE, LifeFileAPI } from "./index.js"
import type { Settings } from "./state.js"
export const LIFEFILE_PRESETS: Record<string, FaultPreset> = {
  reject: {
    description: "Best-guess business rejection without creating an order",
    rules: [{ operationId: "CreateOrder", effect: "reject" }],
  },
  server_error: {
    description: "500 without creating an order",
    rules: [{ status: 500, body: { type: "error", message: "Emulator server error" } }],
  },
  malformed: {
    description: "Malformed JSON without creating an order",
    rules: [{ status: 200, body: "{invalid", headers: { "content-type": "application/json" } }],
  },
  duplicate_push: {
    description: "Two copies of each create push",
    rules: [{ operationId: "CreateOrder", effect: "duplicate_push" }],
  },
  bad_push_credentials: {
    description: "Create push carries deliberately invalid Basic credentials",
    rules: [{ operationId: "CreateOrder", effect: "bad_push_credentials" }],
  },
}
export type LifeFileRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminPrefix?: string
  adminKey?: string
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
  settings?: Partial<Settings>
  webhooks?: {
    url: string
    username: string
    password: string
    fetch?: (request: Request) => Promise<Response>
  }
}
export type LifeFileRuntime = ServiceRuntime<LifeFileAPI> & { webhooks: WebhookHub }
const json = (status: number, body: unknown) => Response.json(body, { status })
const admin = (runtime: ServiceRuntime<LifeFileAPI>): AdminRoutes => ({
  "GET /orders": ({ namespace }) =>
    json(200, {
      orders: runtime
        .instance(namespace)
        .state.orders.list()
        .map((row) => row.value),
    }),
  "GET /settings": ({ namespace }) => {
    const { accounts, ...settings } = runtime.instance(namespace).state.current()
    return json(200, { ...settings, accounts: accounts.map((a) => ({ username: a.username })) })
  },
  "PUT /settings": ({ namespace, body }) => {
    if (!body || typeof body !== "object" || Array.isArray(body))
      return json(400, { error: "Expected settings object" })
    const patch = body as Record<string, unknown>
    for (const key of Object.keys(patch))
      if (
        ![
          "accounts",
          "refusedShippingStates",
          "cancelStatus",
          "pushFormat",
          "pushBeforeResponse",
        ].includes(key)
      )
        return json(400, { error: `Unknown setting ${key}` })
    if (
      (patch.cancelStatus !== undefined &&
        patch.cancelStatus !== null &&
        (typeof patch.cancelStatus !== "string" || patch.cancelStatus.length === 0)) ||
      (patch.pushFormat !== undefined &&
        patch.pushFormat !== "consumer" &&
        patch.pushFormat !== "vendor") ||
      (patch.pushBeforeResponse !== undefined && typeof patch.pushBeforeResponse !== "boolean") ||
      (patch.refusedShippingStates !== undefined &&
        (!Array.isArray(patch.refusedShippingStates) ||
          patch.refusedShippingStates.some((v) => typeof v !== "string"))) ||
      (patch.accounts !== undefined &&
        (!Array.isArray(patch.accounts) ||
          patch.accounts.some(
            (v) =>
              !v ||
              typeof v !== "object" ||
              typeof v.username !== "string" ||
              !v.username ||
              typeof v.password !== "string" ||
              !v.password,
          )))
    )
      return json(400, { error: "Invalid settings" })
    const state = runtime.instance(namespace).state
    state.settings.insert("settings", { ...state.current(), ...patch } as Settings)
    return json(200, { updated: true })
  },
  "POST /orders/:id/push": async ({ namespace, params, body }) => {
    const data = body as Record<string, unknown> | null
    if (
      !data ||
      typeof data.status !== "string" ||
      !data.status ||
      (data.duplicate !== undefined && typeof data.duplicate !== "boolean") ||
      (data.badCredentials !== undefined && typeof data.badCredentials !== "boolean")
    )
      return json(400, { error: "Expected {status, duplicate?, badCredentials?}" })
    const result = await runtime.instance(namespace).transition(params.id ?? "", data.status, {
      duplicate: data.duplicate === true,
      badCredentials: data.badCredentials === true,
    })
    return result ? json(200, result) : json(404, { error: "Order not found" })
  },
})
export const createRuntime = (options: LifeFileRuntimeOptions = {}): LifeFileRuntime => {
  const hub = createWebhookHub({
    signer: signers.custom(({ secret, tags }) => ({
      authorization: `Basic ${btoa(tags.badCredentials === "true" ? "invalid:invalid" : (secret ?? ""))}`,
    })),
    retryDelaysMs: [0],
    endpoints: options.webhooks
      ? [
          {
            url: options.webhooks.url,
            secret: `${options.webhooks.username}:${options.webhooks.password}`,
          },
        ]
      : [],
    ...(options.webhooks?.fetch ? { fetch: options.webhooks.fetch } : {}),
  })
  const runtime = createServiceRuntime<LifeFileAPI>({
    name: LIFEFILE_NAMESPACE,
    document,
    credential: basicUsername,
    presets: LIFEFILE_PRESETS,
    webhooks: hub,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix !== undefined ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    create: ({ sqlite, namespace, publicNamespace, clock }) => {
      const api = new LifeFileAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.settings ? { settings: options.settings } : {}),
        onPush: async (order, controls) => {
          const consumer = {
            orderId: order.orderId,
            ...(order.referenceId ? { referenceId: order.referenceId } : {}),
            status: order.status,
          }
          const body =
            api.state.current().pushFormat === "vendor"
              ? [
                  {
                    orderId: order.orderId,
                    referenceId: order.referenceId,
                    rxStatus: order.status,
                    rxStatusDateTime: order.updatedAt,
                  },
                ]
              : consumer
          for (let i = 0; i < (controls.duplicate ? 2 : 1); i++)
            hub.publish({
              namespace: publicNamespace,
              type: "order.status",
              body,
              tags: { badCredentials: String(controls.badCredentials === true) },
            })
          if (api.state.current().pushBeforeResponse) await hub.flush()
        },
      })
      return api
    },
    admin,
  })
  return Object.assign(runtime, { webhooks: hub })
}
