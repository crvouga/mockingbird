/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type TextractRuntime, type TextractRuntimeOptions } from "./runtime.js"
export const DEFAULT_PORT = 8818
export type TextractServerOptions = TextractRuntimeOptions & { port?: number; host?: string }
export const createServer = async (
  options: TextractServerOptions = {},
): Promise<Listening & { runtime: TextractRuntime }> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  return { ...(await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })), runtime }
}
export const serveTarget: ServeTarget = {
  name: "textract",
  defaultPort: DEFAULT_PORT,
  create: (_values, common) =>
    createRuntime({
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }),
  banner: () => [
    "Point TextractClient endpoint at this URL",
    "admin: seed block graphs and transition analysis jobs",
  ],
}
