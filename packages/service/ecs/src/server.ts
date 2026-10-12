import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type ECSRuntime, type ECSRuntimeOptions } from "./runtime.js"
export const DEFAULT_PORT = 12129
export type ECSServerOptions = ECSRuntimeOptions & { port?: number; host?: string }
export const createServer = async (
  options: ECSServerOptions = {},
): Promise<Listening & { runtime: ECSRuntime }> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  return { ...(await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })), runtime }
}
export const serveTarget: ServeTarget = {
  name: "ecs",
  defaultPort: DEFAULT_PORT,
  create: (_values, common) =>
    createRuntime({
      ...(common.adminPrefix !== undefined ? { adminPrefix: common.adminPrefix } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.adminControls !== undefined ? { adminControls: common.adminControls } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }),
  banner: () => [
    "Point boto3 ecs endpoint_url here; seed clusters/taskDefinitions through /__admin/state",
  ],
}
