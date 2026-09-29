/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type HermesRuntime, type HermesRuntimeOptions } from "./runtime.js"

export const DEFAULT_PORT = 8827
export type HermesServerOptions = HermesRuntimeOptions & { port?: number; host?: string }
export type HermesServer = Listening & { runtime: HermesRuntime }

/** Node-only HTTP entry for the Hermes runtime. */
export const createServer = async (options: HermesServerOptions = {}): Promise<HermesServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, {
    port: port ?? 0,
    ...(host !== undefined ? { host } : {}),
  })
  return { ...listening, runtime }
}

export const serveTarget: ServeTarget = {
  name: "hermes",
  defaultPort: DEFAULT_PORT,
  create: (_values, common) =>
    createRuntime({
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }),
  banner: () => ["Hermes WIP: submission/polling with synthetic lifecycle controls; no inference"],
}
