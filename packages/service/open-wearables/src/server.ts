import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type WearablesRuntime, type WearablesRuntimeOptions } from "./runtime.js"
export const DEFAULT_PORT = 8928
export type WearablesServerOptions = WearablesRuntimeOptions & { port?: number; host?: string }
export type WearablesServer = Listening & { runtime: WearablesRuntime }
export const createServer = async (
  options: WearablesServerOptions = {},
): Promise<WearablesServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  return {
    ...(await listen(runtime, { port: port ?? 0, ...(host !== undefined ? { host } : {}) })),
    runtime,
  }
}
export const serveTarget: ServeTarget = {
  name: "open-wearables",
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
}
