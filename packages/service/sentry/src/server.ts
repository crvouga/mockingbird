/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type SentryRuntime, type SentryRuntimeOptions } from "./runtime.js"
export const DEFAULT_PORT = 8810
export type SentryServerOptions = SentryRuntimeOptions & { port?: number; host?: string }
export type SentryServer = Listening & { runtime: SentryRuntime }
export const createServer = async (options: SentryServerOptions = {}): Promise<SentryServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  return { ...(await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })), runtime }
}
export const serveTarget: ServeTarget = {
  name: "sentry",
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
    "DSN: http://<fixture-public-key>@127.0.0.1:<port>/1; REST: Bearer fixture-rest-token",
  ],
}
