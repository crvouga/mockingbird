import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type TavilyRuntime, type TavilyRuntimeOptions } from "./runtime.js"
export const DEFAULT_PORT = 12130
export type TavilyServerOptions = TavilyRuntimeOptions & { port?: number; host?: string }
export const createServer = async (
  options: TavilyServerOptions = {},
): Promise<Listening & { runtime: TavilyRuntime }> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  return { ...(await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })), runtime }
}
export const serveTarget: ServeTarget = {
  name: "tavily",
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
    "Point AsyncTavilyClient api_base_url here; seed searches/extractions through /__admin/state",
  ],
}
