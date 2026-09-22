/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type KillBillRuntime, type KillBillRuntimeOptions } from "./runtime.js"
export const DEFAULT_PORT = 8820
export type KillBillServerOptions = KillBillRuntimeOptions & { port?: number; host?: string }
export const createServer = async (
  options: KillBillServerOptions = {},
): Promise<Listening & { runtime: KillBillRuntime }> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  return { ...(await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })), runtime }
}
export const serveTarget: ServeTarget = {
  name: "kill-bill",
  defaultPort: DEFAULT_PORT,
  create: (_values, common) =>
    createRuntime({
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }),
  banner: () => [
    "Set KILL_BILL_URL to this URL",
    "admin: catalog, payment outcomes, retry and billing state controls",
  ],
}
