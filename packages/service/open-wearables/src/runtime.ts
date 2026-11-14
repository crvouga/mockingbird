import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  HttpError,
  jsonRes,
  type MockControls,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import { apiKeyCredential, WEARABLES_NAMESPACE, WearablesAPI } from "./index.js"
import type { Settings } from "./state.js"
export type WearablesRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminPrefix?: string
  adminKey?: string
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
  settings?: Partial<Settings>
}
export type WearablesRuntime = ServiceRuntime<WearablesAPI>
const record = (body: unknown): Record<string, unknown> =>
  typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {}
const admin = (runtime: WearablesRuntime): AdminRoutes => ({
  "POST /users/:user_id/connections": ({ params, body, namespace }) => {
    const input = record(body)
    if (
      typeof input.provider !== "string" ||
      (input.status !== undefined &&
        !["active", "revoked", "expired"].includes(String(input.status)))
    )
      return jsonRes(400, { error: "Expected provider and optional active/revoked/expired status" })
    try {
      return jsonRes(
        200,
        runtime
          .instance(namespace)
          .seedConnection(
            params.user_id as string,
            input.provider,
            input.status as "active" | "revoked" | "expired" | undefined,
          ),
      )
    } catch (error) {
      if (error instanceof HttpError) return error.toResponse()
      throw error
    }
  },
  "POST /tasks/:task_id/complete": ({ params, namespace }) => {
    try {
      return jsonRes(200, runtime.instance(namespace).completeTask(params.task_id as string))
    } catch (error) {
      if (error instanceof HttpError) return error.toResponse()
      throw error
    }
  },
  "PUT /providers/:provider": ({ params, body, namespace }) => {
    const api = runtime.instance(namespace)
    const provider = api.state.providers.get(params.provider as string)
    if (!provider) return jsonRes(404, { error: "Unknown provider" })
    const input = record(body)
    if (typeof input.is_enabled !== "boolean")
      return jsonRes(400, { error: "Expected is_enabled boolean" })
    const next = { ...provider, is_enabled: input.is_enabled }
    api.state.providers.update(provider.provider, next)
    return jsonRes(200, next)
  },
  "GET /settings": ({ namespace }) => jsonRes(200, runtime.instance(namespace).state.current()),
  "PUT /settings": ({ namespace, body }) => {
    const input = record(body)
    if (
      input.autoCompleteAfterMs !== undefined &&
      input.autoCompleteAfterMs !== null &&
      (typeof input.autoCompleteAfterMs !== "number" ||
        !Number.isFinite(input.autoCompleteAfterMs) ||
        input.autoCompleteAfterMs < 0)
    )
      return jsonRes(400, { error: "autoCompleteAfterMs must be null or a nonnegative number" })
    if (
      input.apiKeys !== undefined &&
      (!Array.isArray(input.apiKeys) || input.apiKeys.some((key) => typeof key !== "string"))
    )
      return jsonRes(400, { error: "apiKeys must be strings" })
    const state = runtime.instance(namespace).state
    const next = {
      ...state.current(),
      ...(input.autoCompleteAfterMs !== undefined
        ? { autoCompleteAfterMs: input.autoCompleteAfterMs as number | null }
        : {}),
      ...(input.apiKeys !== undefined ? { apiKeys: input.apiKeys as string[] } : {}),
    }
    state.settings.update("current", next)
    return jsonRes(200, next)
  },
})
export const createRuntime = (options: WearablesRuntimeOptions = {}): WearablesRuntime => {
  const runtime = createServiceRuntime<WearablesAPI>({
    name: WEARABLES_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix !== undefined ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: apiKeyCredential,
    state: [
      { name: "users", label: "Users" },
      { name: "providers", label: "Providers" },
      { name: "connections", label: "Connections" },
      { name: "tasks", label: "Sync tasks" },
      { name: "settings", label: "Settings" },
    ],
    create: ({ sqlite, namespace, clock }) =>
      new WearablesAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.settings ? { settings: options.settings } : {}),
      }),
    admin,
    onClockChange: (namespace) => runtime.instance(namespace).tick(),
  })

  return runtime
}
