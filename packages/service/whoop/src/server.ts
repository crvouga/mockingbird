/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type WhoopRuntime, type WhoopRuntimeOptions } from "./runtime.js"
export const DEFAULT_PORT = 12129
export type WhoopServerOptions = WhoopRuntimeOptions & { port?: number; host?: string }
export type WhoopServer = Listening & { runtime: WhoopRuntime }
export const createServer = async (options: WhoopServerOptions = {}): Promise<WhoopServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })
  return { ...listening, runtime }
}
export const serveTarget: ServeTarget = {
  name: "whoop",
  defaultPort: DEFAULT_PORT,
  options: {},
  create: (_values, common) =>
    createRuntime({
      ...(common.adminPrefix !== undefined ? { adminPrefix: common.adminPrefix } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.adminControls !== undefined ? { adminControls: common.adminControls } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }),
  banner: () => [
    "auth: Bearer mock_whoop_token",
    "collections: GET /developer/v2/activity/workout",
  ],
}
