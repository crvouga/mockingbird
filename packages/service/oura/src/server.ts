/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type OuraRuntime, type OuraRuntimeOptions } from "./runtime.js"
export const DEFAULT_PORT = 12128
export type OuraServerOptions = OuraRuntimeOptions & { port?: number; host?: string }
export type OuraServer = Listening & { runtime: OuraRuntime }
export const createServer = async (options: OuraServerOptions = {}): Promise<OuraServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })
  return { ...listening, runtime }
}
export const serveTarget: ServeTarget = {
  name: "oura",
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
  banner: () => ["auth: Bearer mock_oura_token", "collections: GET /v2/usercollection/workout"],
}
