/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type VantaRuntime, type VantaRuntimeOptions } from "./runtime.js"
export const DEFAULT_PORT = 12129
export type VantaServerOptions = VantaRuntimeOptions & { port?: number; host?: string }
export type VantaServer = Listening & { runtime: VantaRuntime }
export const createServer = async (options: VantaServerOptions = {}): Promise<VantaServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })
  return { ...listening, runtime }
}
export const serveTarget: ServeTarget = {
  name: "vanta",
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
  banner: () => ["auth: Bearer mock_vanta_token", "people: GET /v1/people"],
}
