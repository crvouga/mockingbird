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
import { NOTION_NAMESPACE, NotionAPI, type NotionAPIOptions } from "./index.js"
export const NOTION_PRESETS: Record<string, FaultPreset> = {
  unauthorized: {
    description: "Rejected bearer token",
    rules: [
      {
        status: 401,
        body: {
          object: "error",
          status: 401,
          code: "unauthorized",
          message: "API token is invalid.",
        },
      },
    ],
  },
  rate_limited: {
    description: "Scripted API throttle",
    rules: [
      {
        status: 429,
        body: {
          object: "error",
          status: 429,
          code: "rate_limited",
          message: "Rate limit exceeded.",
        },
        headers: { "retry-after": "1" },
      },
    ],
  },
  server_error: {
    description: "Transient API failure",
    rules: [
      {
        status: 503,
        body: {
          object: "error",
          status: 503,
          code: "service_unavailable",
          message: "Service unavailable.",
        },
      },
    ],
  },
  connection_drop: { description: "Connection closes before write", rules: [{ drop: true }] },
}
export type NotionRuntimeOptions = Omit<NotionAPIOptions, "now" | "namespace"> & {
  clock?: Clock
  seed?: string | number
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
}
export type NotionRuntime = ServiceRuntime<NotionAPI>
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const adminRoutes = (runtime: NotionRuntime): AdminRoutes => ({
  "PUT /pages/:id/blocks": ({ params, body, namespace }) => {
    if (typeof body !== "object" || body === null || Array.isArray(body))
      return adminError(
        400,
        'expected {"blocks": [{type, text?, children?}], "workspaceId"?, "title"?}',
      )
    const { blocks, workspaceId, title } = body as Record<string, unknown>
    if (
      (workspaceId !== undefined && typeof workspaceId !== "string") ||
      (title !== undefined && typeof title !== "string")
    )
      return adminError(400, "workspaceId and title must be strings")
    const seeded = runtime.instance(namespace).seedBlocks(params.id as string, blocks, {
      ...(workspaceId !== undefined ? { workspaceId } : {}),
      ...(title !== undefined ? { title } : {}),
    })
    return typeof seeded === "string" ? adminError(400, seeded) : json(200, seeded)
  },
})
export const createRuntime = (options: NotionRuntimeOptions = {}): NotionRuntime =>
  createServiceRuntime({
    name: NOTION_NAMESPACE,
    document,
    presets: NOTION_PRESETS,
    credential: bearerToken,
    admin: adminRoutes,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    create: ({ sqlite, namespace, clock }) =>
      new NotionAPI({ ...options, sqlite, namespace, now: clock.now }),
  })
