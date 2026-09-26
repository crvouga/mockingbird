/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type LiveKitRuntime, type LiveKitRuntimeOptions } from "./runtime.js"
export const DEFAULT_PORT = 8819
export type LiveKitServerOptions = LiveKitRuntimeOptions & { port?: number; host?: string }
export const createServer = async (
  options: LiveKitServerOptions = {},
): Promise<Listening & { runtime: LiveKitRuntime }> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  return { ...(await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })), runtime }
}
export const serveTarget: ServeTarget = {
  name: "livekit",
  defaultPort: DEFAULT_PORT,
  create: (_values, common) =>
    createRuntime({
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }),
  banner: () => [
    "Point RoomServiceClient at this URL",
    "admin: join participants, publish tracks, inspect inboxes and async resources",
  ],
}
