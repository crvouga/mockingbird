/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type PlaneRuntime, type PlaneRuntimeOptions } from "./runtime.js"

/** Port `mockingbird-plane serve` listens on when none is given. */
export const DEFAULT_PORT = 8821

export type PlaneServerOptions = PlaneRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type PlaneServer = Listening & { runtime: PlaneRuntime }

/** Serve the Plane mock over `node:http`. */
export const createServer = async (options: PlaneServerOptions = {}): Promise<PlaneServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, {
    port: port ?? 0,
    ...(host !== undefined ? { host } : {}),
  })
  return { ...listening, runtime }
}

const text = (value: string | boolean | undefined) =>
  typeof value === "string" ? value : undefined

/** How `serve` (and `serve --config`) builds the Plane mock from flags. */
export const serveTarget: ServeTarget = {
  name: "plane",
  defaultPort: DEFAULT_PORT,
  options: {
    "api-key": {
      type: "string",
      value: "<key>",
      description: "Accept only this X-API-Key (the app's PLANE_ACCESS_TOKEN); default: any key",
    },
    "rate-limit": {
      type: "string",
      value: "<per-minute>",
      description: "Answer 429 past this many requests per minute per key (Plane allows 60)",
    },
  },
  create: (values, common) => {
    const key = text(values["api-key"])
    const limit = text(values["rate-limit"])
    return createRuntime({
      settings: {
        ...(key ? { apiKeys: [key] } : {}),
        ...(limit ? { rateLimitPerMinute: Number(limit) } : {}),
      },
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "auth: X-API-Key: <token>; projects are provisioned on first use with Plane's default states",
    "namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<api key>: <ns>}",
  ],
}
