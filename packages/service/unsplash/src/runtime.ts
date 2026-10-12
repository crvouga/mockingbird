import {
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  type MockControls,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import { accessKey, type PhotoFixture, UNSPLASH_NAMESPACE, UnsplashAPI } from "./index.js"
export const UNSPLASH_PRESETS: Record<string, FaultPreset> = {
  unauthorized: {
    description: "Access key rejected",
    rules: [{ status: 401, body: { errors: ["OAuth error: The access token is invalid"] } }],
  },
  rate_limited: {
    description: "Scripted quota exhaustion",
    rules: [
      {
        status: 403,
        body: { errors: ["Rate Limit Exceeded"] },
        headers: { "x-ratelimit-remaining": "0" },
      },
    ],
  },
  server_error: {
    description: "Transient server failure",
    rules: [{ status: 503, body: { errors: ["Service unavailable"] } }],
  },
  connection_drop: { description: "Connection closes before response", rules: [{ drop: true }] },
}
export type UnsplashRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: string | number
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
  accessKeys?: string[]
  photos?: PhotoFixture[]
}
export type UnsplashRuntime = ServiceRuntime<UnsplashAPI>
export const createRuntime = (options: UnsplashRuntimeOptions = {}): UnsplashRuntime =>
  createServiceRuntime({
    name: UNSPLASH_NAMESPACE,
    document,
    presets: UNSPLASH_PRESETS,
    credential: accessKey,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    create: ({ sqlite, namespace, publicNamespace, adminPrefix, clock }) =>
      new UnsplashAPI({
        sqlite,
        namespace,
        publicNamespace,
        adminPrefix,
        now: clock.now,
        ...(options.photos ? { photos: options.photos } : {}),
        ...(options.accessKeys ? { accessKeys: options.accessKeys } : {}),
      }),
  })
