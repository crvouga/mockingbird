import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { type CheckrRuntime, type CheckrRuntimeOptions, createRuntime } from "./runtime.js"
export const DEFAULT_PORT = 12129
export const createServer = async (
  options: CheckrRuntimeOptions & { port?: number; host?: string } = {},
): Promise<Listening & { runtime: CheckrRuntime }> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  return { ...(await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })), runtime }
}
export const serveTarget: ServeTarget = {
  name: "checkr",
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
  banner: () => ["HTTP Basic: mock_checkr_key as username; empty password"],
}
