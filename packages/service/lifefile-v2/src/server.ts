/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type LifeFileV2Runtime, type LifeFileV2RuntimeOptions } from "./runtime.js"

export const DEFAULT_PORT = 8932

export type LifeFileV2ServerOptions = LifeFileV2RuntimeOptions & { port?: number; host?: string }

export type LifeFileV2Server = Listening & { runtime: LifeFileV2Runtime }

export const createServer = async (
  options: LifeFileV2ServerOptions = {},
): Promise<LifeFileV2Server> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, {
    port: port ?? 0,
    ...(host !== undefined ? { host } : {}),
  })
  return { ...listening, runtime }
}

export const serveTarget: ServeTarget = {
  name: "lifefile-v2",
  defaultPort: DEFAULT_PORT,
  create: (_values, common) =>
    createRuntime({
      ...(common.adminPrefix !== undefined ? { adminPrefix: common.adminPrefix } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.adminControls !== undefined ? { adminControls: common.adminControls } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }),
}
