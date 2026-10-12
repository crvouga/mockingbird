/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { type BrevoRuntime, type BrevoRuntimeOptions, createRuntime } from "./runtime.js"
export const DEFAULT_PORT = 12124
export type BrevoServerOptions = BrevoRuntimeOptions & { port?: number; host?: string }
export type BrevoServer = Listening & { runtime: BrevoRuntime }
export const createServer = async (options: BrevoServerOptions = {}): Promise<BrevoServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })
  return { ...listening, runtime }
}
export const serveTarget: ServeTarget = {
  name: "brevo",
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
  banner: () => ["auth: api-key: mock_brevo_key", "contacts: POST /v3/contacts"],
}
