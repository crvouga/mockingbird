/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type MetaRuntime, type MetaRuntimeOptions } from "./runtime.js"

export const DEFAULT_PORT = 12122

export type MetaServerOptions = MetaRuntimeOptions & { port?: number; host?: string }
export type MetaServer = Listening & { runtime: MetaRuntime }

export const createServer = async (options: MetaServerOptions = {}): Promise<MetaServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, {
    port: port ?? 0,
    ...(host !== undefined ? { host } : {}),
  })
  return { ...listening, runtime }
}

export const serveTarget: ServeTarget = {
  name: "meta",
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
    "auth: Authorization: Bearer <synthetic token>, or ?access_token=...",
    "fixtures: act_mockingbird, cmp_mockingbird, set_mockingbird, ad_mockingbird",
    "namespaces: x-mockingbird-namespace, /__admin/ns/<name>/…, or credential mapping",
  ],
}
