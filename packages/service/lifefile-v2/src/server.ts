/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type LifeFileV2Runtime, type LifeFileV2RuntimeOptions } from "./runtime.js"
import type { Settings } from "./types.js"

export const DEFAULT_PORT = 8932

export const SERVE_LIMITS = { maxOrders: 25_000, maxApiUsers: 1_000, maxSnapshots: 50 } as const

export type LifeFileV2ServerOptions = LifeFileV2RuntimeOptions & { port?: number; host?: string }

export type LifeFileV2Server = Listening & { runtime: LifeFileV2Runtime }

export const createServer = async (
  options: LifeFileV2ServerOptions = {},
): Promise<LifeFileV2Server> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, {
    port: port ?? 0,
    ...(host !== undefined ? { host } : {}),
  })
  return { ...listening, runtime }
}

const text = (value: string | boolean | undefined) =>
  typeof value === "string" && value.length > 0 ? value : undefined

export const serveTarget: ServeTarget = {
  name: "lifefile-v2",
  defaultPort: DEFAULT_PORT,
  options: {
    "push-url": {
      type: "string",
      value: "<url>",
      description: "Deliver Data Push here (e.g. http://127.0.0.1:3100/webhooks/lifefile)",
    },
    "push-username": {
      type: "string",
      value: "<user>",
      description: "Basic auth user for --push-url",
    },
    "push-password": {
      type: "string",
      value: "<pass>",
      description: "Basic auth password for --push-url",
    },
    catalog: {
      type: "string",
      value: "sandbox|production",
      description: "Status codes, locations and shipping services to start with (default sandbox)",
    },
    "client-id": {
      type: "string",
      value: "<id>",
      description: "API user to seed (default lifefile-client)",
    },
    "client-secret": {
      type: "string",
      value: "<secret>",
      description: "Its secret (default lifefile-secret)",
    },
    "no-latency": {
      type: "boolean",
      description: "Answer at once instead of the recorded latency",
    },
    "open-enrollment": {
      type: "boolean",
      description:
        "Let any new client id sign in even with --client-id set (on by default without it)",
    },
    "max-orders": {
      type: "string",
      value: "<n>",
      description: `Orders one namespace may hold before creates answer 507 (default ${SERVE_LIMITS.maxOrders})`,
    },
    "max-api-users": {
      type: "string",
      value: "<n>",
      description: `API users open enrollment may add to one namespace (default ${SERVE_LIMITS.maxApiUsers})`,
    },
    "max-records": {
      type: "string",
      value: "<n>",
      description:
        "Hard cap on every record of a namespace (off by default: each insert then counts the namespace)",
    },
    "max-snapshots": {
      type: "string",
      value: "<n>",
      description: `Snapshots one namespace may keep (default ${SERVE_LIMITS.maxSnapshots})`,
    },
    "checkpoint-mutations": {
      type: "boolean",
      description:
        "Record a time-travel checkpoint after every write (off by default: each one reads the whole namespace)",
    },
    "namespace-idle-ms": {
      type: "string",
      value: "<ms>",
      description:
        "Forget a namespace idle this long on the wall clock (default 1800000; 0 keeps them)",
    },
  },
  create: (values, common) => {
    const url = text(values["push-url"])
    const catalog = text(values.catalog)
    if (catalog !== undefined && catalog !== "sandbox" && catalog !== "production") {
      throw new Error("--catalog is sandbox or production")
    }
    const idle = Number(text(values["namespace-idle-ms"]) ?? 1_800_000)
    if (!Number.isInteger(idle) || idle < 0)
      throw new Error("--namespace-idle-ms is a whole number")
    const count = (flag: string, fallback?: number) => {
      const raw = text(values[flag])
      if (raw === undefined) return fallback
      const value = Number(raw)
      if (!Number.isInteger(value) || value < 1) throw new Error(`--${flag} is a whole number >= 1`)
      return value
    }
    const maxRecords = count("max-records")
    const maxSnapshots = count("max-snapshots", SERVE_LIMITS.maxSnapshots)
    const maxOrders = count("max-orders", SERVE_LIMITS.maxOrders)
    const maxApiUsers = count("max-api-users", SERVE_LIMITS.maxApiUsers)
    const clientId = text(values["client-id"])
    const clientSecret = text(values["client-secret"])
    const seeded = clientId !== undefined || clientSecret !== undefined
    const settings: Partial<Settings> = {
      ...(catalog ? { catalog, ...(catalog === "production" ? { intake: null } : {}) } : {}),
      ...(seeded && values["open-enrollment"] !== true ? { openEnrollment: false } : {}),
    }
    return createRuntime({
      ...(url
        ? {
            push: {
              url,
              username: text(values["push-username"]) ?? "",
              password: text(values["push-password"]) ?? "",
            },
          }
        : {}),
      ...(Object.keys(settings).length > 0 ? { settings } : {}),
      ...(clientId || clientSecret
        ? {
            apiUsers: [
              {
                ...(clientId ? { clientId } : {}),
                ...(clientSecret ? { secret: clientSecret } : {}),
              },
            ],
          }
        : {}),
      ...(values["no-latency"] === true ? { latency: "none" as const } : {}),
      namespaceIdleMs: idle,
      ...(maxRecords !== undefined ? { maxRecords } : {}),
      ...(maxSnapshots !== undefined ? { maxSnapshots } : {}),
      ...(maxOrders !== undefined ? { maxOrders } : {}),
      ...(maxApiUsers !== undefined ? { maxApiUsers } : {}),
      checkpointMutations: values["checkpoint-mutations"] === true,
      ...(common.adminPrefix !== undefined ? { adminPrefix: common.adminPrefix } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.adminControls !== undefined ? { adminControls: common.adminControls } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "api:  <url>/api/v2 (token at POST /api/v2/auth/token, form grant_type=client_credentials, X-Vendor-ID: 10001)",
    "user: lifefile-client / lifefile-secret, or any new client id (open enrollment) unless --client-id is set",
    "push: --push-url with Basic auth; PUT /__admin/push sets it per namespace",
  ],
}
