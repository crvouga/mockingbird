/// <reference types="node" />
import {
  type Listening,
  listen,
  providerServeOptions,
  providerServeValues,
  type ServeTarget,
} from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type LinearRuntime, type LinearRuntimeOptions } from "./runtime.js"
export const DEFAULT_PORT = 8907
export type LinearServerOptions = LinearRuntimeOptions & { port?: number; host?: string }
export type LinearServer = Listening & { runtime: LinearRuntime }
export async function createServer(options: LinearServerOptions = {}): Promise<LinearServer> {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const server = await listen(runtime, { port: port ?? 0, ...(host !== undefined ? { host } : {}) })
  return { ...server, runtime }
}
export const serveTarget: ServeTarget = {
  name: "linear",
  defaultPort: DEFAULT_PORT,
  options: providerServeOptions,
  create: async (values, common) =>
    createRuntime({
      ...(await providerServeValues<NonNullable<LinearRuntimeOptions["fixtures"]>>(values, common)),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.adminPrefix !== undefined ? { adminPrefix: common.adminPrefix } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.adminControls !== undefined ? { adminControls: common.adminControls } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }),
  banner: () => ["Native Mockingbird namespaces and /__admin controls"],
}
