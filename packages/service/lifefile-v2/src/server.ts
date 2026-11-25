/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type LifeFileV2Runtime, type LifeFileV2RuntimeOptions } from "./runtime.js"

export const DEFAULT_PORT = 8932

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
    const clientId = text(values["client-id"])
    const clientSecret = text(values["client-secret"])
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
      ...(catalog
        ? { settings: { catalog, ...(catalog === "production" ? { intake: null } : {}) } }
        : {}),
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
      ...(common.adminPrefix !== undefined ? { adminPrefix: common.adminPrefix } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.adminControls !== undefined ? { adminControls: common.adminControls } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "api:  <url>/api/v2 (token at POST /api/v2/auth/token, form grant_type=client_credentials, X-Vendor-ID: 10001)",
    "user: lifefile-client / lifefile-secret, or any new client id (open enrollment)",
    "push: --push-url with Basic auth; PUT /__admin/push sets it per namespace",
  ],
}
