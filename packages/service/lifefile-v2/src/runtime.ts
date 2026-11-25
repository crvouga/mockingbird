import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  createWebhookHub,
  type FaultPreset,
  type MockControls,
  type RequestLog,
  type ServiceRuntime,
  type WebhookHub,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import { LIFEFILE_V2_NAMESPACE, LifeFileV2API, tokenCredential } from "./index.js"
import type { ApiUser, PushTarget, Settings } from "./types.js"
import { basicPushSigner, PUSH_RETRY_DELAYS_MS } from "./webhooks.js"

export const LIFEFILE_V2_PRESETS: Record<string, FaultPreset> = {}

export type LifeFileV2RuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminPrefix?: string
  adminKey?: string
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
  settings?: Partial<Settings>
  apiUsers?: readonly Partial<ApiUser>[]
  latency?: "recorded" | "none"
  namespaceIdleMs?: number
  maxRecords?: number
  maxSnapshots?: number
  push?: PushTarget & {
    retryDelaysMs?: readonly number[]
    fetch?: (request: Request) => Promise<Response>
  }
}

export type LifeFileV2Runtime = ServiceRuntime<LifeFileV2API> & { readonly webhooks: WebhookHub }

const admin = (_runtime: ServiceRuntime<LifeFileV2API>): AdminRoutes => ({})

export const createRuntime = (options: LifeFileV2RuntimeOptions = {}): LifeFileV2Runtime => {
  const hub = createWebhookHub({
    signer: basicPushSigner(),
    retryDelaysMs: options.push?.retryDelaysMs ?? PUSH_RETRY_DELAYS_MS,
    ...(options.push?.fetch ? { fetch: options.push.fetch } : {}),
  })
  const runtime = createServiceRuntime<LifeFileV2API>({
    name: LIFEFILE_V2_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix !== undefined ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: tokenCredential,
    presets: LIFEFILE_V2_PRESETS,
    webhooks: hub,
    create: ({ sqlite, namespace, clock }) =>
      new LifeFileV2API({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.settings ? { settings: options.settings } : {}),
        ...(options.apiUsers ? { apiUsers: options.apiUsers } : {}),
      }),
    admin,
  })
  return Object.assign(runtime, { webhooks: hub })
}
