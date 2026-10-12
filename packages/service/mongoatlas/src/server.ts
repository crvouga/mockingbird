/// <reference types="node" />
import {
  type Listening,
  listen,
  providerServeOptions,
  providerServeValues,
  type ServeTarget,
} from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type MongoAtlasRuntime, type MongoAtlasRuntimeOptions } from "./runtime.js"
export const DEFAULT_PORT = 8905
export type MongoAtlasServerOptions = MongoAtlasRuntimeOptions & { port?: number; host?: string }
export type MongoAtlasServer = Listening & { runtime: MongoAtlasRuntime }
export async function createServer(
  options: MongoAtlasServerOptions = {},
): Promise<MongoAtlasServer> {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const server = await listen(runtime, { port: port ?? 0, ...(host !== undefined ? { host } : {}) })
  return { ...server, runtime }
}
export const serveTarget: ServeTarget = {
  name: "mongoatlas",
  defaultPort: DEFAULT_PORT,
  options: providerServeOptions,
  create: async (values, common) =>
    createRuntime({
      ...(await providerServeValues<NonNullable<MongoAtlasRuntimeOptions["fixtures"]>>(
        values,
        common,
      )),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.adminPrefix !== undefined ? { adminPrefix: common.adminPrefix } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.adminControls !== undefined ? { adminControls: common.adminControls } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }),
  banner: () => ["Native Mockingbird namespaces and /__admin controls"],
}
