/// <reference types="node" />
import {
  type Listening,
  listen,
  providerServeOptions,
  providerServeValues,
  type ServeTarget,
} from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type OktaRuntime, type OktaRuntimeOptions } from "./runtime.js"
export const DEFAULT_PORT = 8904
export type OktaServerOptions = OktaRuntimeOptions & { port?: number; host?: string }
export type OktaServer = Listening & { runtime: OktaRuntime }
export async function createServer(options: OktaServerOptions = {}): Promise<OktaServer> {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const server = await listen(runtime, { port: port ?? 0, ...(host !== undefined ? { host } : {}) })
  return { ...server, runtime }
}
export const serveTarget: ServeTarget = {
  name: "okta",
  defaultPort: DEFAULT_PORT,
  options: providerServeOptions,
  create: async (values, common) =>
    createRuntime({
      ...(await providerServeValues<NonNullable<OktaRuntimeOptions["fixtures"]>>(values, common)),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.adminPrefix !== undefined ? { adminPrefix: common.adminPrefix } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.adminControls !== undefined ? { adminControls: common.adminControls } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }),
  banner: () => ["Native Mockingbird namespaces and /__admin controls"],
}
