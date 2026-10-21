/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type SuuntoRuntime, type SuuntoRuntimeOptions } from "./runtime.js"
export const DEFAULT_PORT = 12141
export type SuuntoServerOptions = SuuntoRuntimeOptions & { port?: number; host?: string }
export type SuuntoServer = Listening & { runtime: SuuntoRuntime }
export const createServer = async (options: SuuntoServerOptions = {}): Promise<SuuntoServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })
  return { ...listening, runtime }
}
export const serveTarget: ServeTarget = {
  name: "suunto",
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
    "auth: Bearer mock_suunto_token (or OAuth: client mock_client / mock_client_secret)",
    "workouts: GET /v3/workouts/",
  ],
}
