/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type KlaviyoRuntime, type KlaviyoRuntimeOptions } from "./runtime.js"

/** Port `mockingbird-klaviyo serve` listens on when none is given. */
export const DEFAULT_PORT = 8811

export type KlaviyoServerOptions = KlaviyoRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type KlaviyoServer = Listening & { runtime: KlaviyoRuntime }

/** Serve the Klaviyo mock over `node:http`. */
export const createServer = async (options: KlaviyoServerOptions = {}): Promise<KlaviyoServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, {
    port: port ?? 0,
    ...(host !== undefined ? { host } : {}),
  })
  return { ...listening, runtime }
}

/** How `serve` (and `serve --config`) builds the Klaviyo mock from flags. */
export const serveTarget: ServeTarget = {
  name: "klaviyo",
  defaultPort: DEFAULT_PORT,
  options: {},
  create: (_values, common) =>
    createRuntime({
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }),
  banner: () => [
    "events: POST /api/events/ with Authorization: Klaviyo-API-Key <key> and revision: 2024-02-15",
    "point KLAVIYO_URL at <this url>/api/events/ (or /ns/<name>/api/events/)",
    "namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<key>: <ns>}",
  ],
}
