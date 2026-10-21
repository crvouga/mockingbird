/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type PolarRuntime, type PolarRuntimeOptions } from "./runtime.js"

/** Port `mockingbird-polar serve` listens on when none is given. */
export const DEFAULT_PORT = 12157
export type PolarServerOptions = PolarRuntimeOptions & { port?: number; host?: string }
export type PolarServer = Listening & { runtime: PolarRuntime }
export const createServer = async (options: PolarServerOptions = {}): Promise<PolarServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })
  return { ...listening, runtime }
}
export const serveTarget: ServeTarget = {
  name: "polar",
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
    "oauth: GET /oauth2/authorization, POST /v2/oauth2/token (client mock_client:mock_client_secret)",
    "api: Bearer mock_polar_token on /v3/users and /v3/exercises",
  ],
}
