/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type VibeRuntime, type VibeRuntimeOptions } from "./runtime.js"
export const DEFAULT_PORT = 12128
export type VibeServerOptions = VibeRuntimeOptions & { port?: number; host?: string }
export type VibeServer = Listening & { runtime: VibeRuntime }
export const createServer = async (options: VibeServerOptions = {}): Promise<VibeServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })
  return { ...listening, runtime }
}
export const serveTarget: ServeTarget = {
  name: "vibe",
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
    "auth: Bearer mock_vibe_token; X-Vibe-Revision: 2026-06-01",
    "reports: POST /reports",
  ],
}
