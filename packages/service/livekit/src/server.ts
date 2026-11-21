/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type LiveKitRuntime, type LiveKitRuntimeOptions } from "./runtime.js"
import { createNodeSignals, type NodeSignalOptions } from "./signal-node.js"
export const DEFAULT_PORT = 8819
export type LiveKitServerOptions = LiveKitRuntimeOptions & {
  port?: number
  host?: string
  signaling?: NodeSignalOptions
}
export const createServer = async (
  options: LiveKitServerOptions = {},
): Promise<Listening & { runtime: LiveKitRuntime }> => {
  const { port, host, signaling, ...rest } = options
  const runtime = createRuntime(rest)
  const signals = signaling ? createNodeSignals(runtime, signaling) : undefined
  const api = {
    fetch: (request: Request) =>
      signals && new URL(request.url).pathname === "/rtc/validate"
        ? signals.validate(request)
        : runtime.fetch(request),
  }
  const listening = await listen(api, { port: port ?? 0, ...(host ? { host } : {}) })
  signals?.attach(listening.server)
  return {
    ...listening,
    runtime,
    close: async () => {
      await signals?.close()
      await listening.close()
    },
  }
}
export const serveTarget: ServeTarget = {
  name: "livekit",
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
    "Point RoomServiceClient at this URL",
    "admin: join participants, publish tracks, inspect inboxes and async resources",
  ],
}
