/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type UnsplashRuntime, type UnsplashRuntimeOptions } from "./runtime.js"
export const DEFAULT_PORT = 12125
export type UnsplashServerOptions = UnsplashRuntimeOptions & { port?: number; host?: string }
export type UnsplashServer = Listening & { runtime: UnsplashRuntime }
export const createServer = async (
  options: UnsplashServerOptions = {},
): Promise<UnsplashServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })
  return { ...listening, runtime }
}
export const serveTarget: ServeTarget = {
  name: "unsplash",
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
    "auth: Authorization: Client-ID mock_unsplash_key",
    "search: GET /search/photos?query=mock",
  ],
}
