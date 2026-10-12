/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type OpenAIRuntime, type OpenAIRuntimeOptions } from "./runtime.js"
export const DEFAULT_PORT = 8813
export type OpenAIServerOptions = OpenAIRuntimeOptions & { port?: number; host?: string }
export type OpenAIServer = Listening & { runtime: OpenAIRuntime }
export const createServer = async (options: OpenAIServerOptions = {}): Promise<OpenAIServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  return { ...(await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })), runtime }
}
export const serveTarget: ServeTarget = {
  name: "openai",
  defaultPort: DEFAULT_PORT,
  create: (_values, common) =>
    createRuntime({
      ...(common.adminPrefix !== undefined ? { adminPrefix: common.adminPrefix } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.adminControls !== undefined ? { adminControls: common.adminControls } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }),
  banner: () => ["Synthetic token: fixture-openai-token; local scripts only"],
}
