/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type FitbitRuntime, type FitbitRuntimeOptions } from "./runtime.js"

export const DEFAULT_PORT = 12141
export type FitbitServerOptions = FitbitRuntimeOptions & { port?: number; host?: string }
export type FitbitServer = Listening & { runtime: FitbitRuntime }
export const createServer = async (options: FitbitServerOptions = {}): Promise<FitbitServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })
  return { ...listening, runtime }
}
export const serveTarget: ServeTarget = {
  name: "fitbit",
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
    "auth: Bearer mock_fitbit_token (client mock_client / mock_client_secret)",
    "profile: GET /1/user/-/profile.json",
  ],
}
