/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type GoogleAdsRuntime, type GoogleAdsRuntimeOptions } from "./runtime.js"
export const DEFAULT_PORT = 8814
export type GoogleAdsServerOptions = GoogleAdsRuntimeOptions & { port?: number; host?: string }
export type GoogleAdsServer = Listening & { runtime: GoogleAdsRuntime }
export const createServer = async (
  options: GoogleAdsServerOptions = {},
): Promise<GoogleAdsServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  return { ...(await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })), runtime }
}
export const serveTarget: ServeTarget = {
  name: "google-ads",
  defaultPort: DEFAULT_PORT,
  create: (_values, common) =>
    createRuntime({
      ...(common.adminPrefix !== undefined ? { adminPrefix: common.adminPrefix } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.adminControls !== undefined ? { adminControls: common.adminControls } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }),
  banner: () => ["Synthetic OAuth token: fixture-google-ads-token"],
}
