/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type VercelBlobRuntime, type VercelBlobRuntimeOptions } from "./runtime.js"
export const DEFAULT_PORT = 8812
export type VercelBlobServerOptions = VercelBlobRuntimeOptions & { port?: number; host?: string }
export type VercelBlobServer = Listening & { runtime: VercelBlobRuntime }
export const createServer = async (
  options: VercelBlobServerOptions = {},
): Promise<VercelBlobServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  return { ...(await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })), runtime }
}
export const serveTarget: ServeTarget = {
  name: "vercel-blob",
  defaultPort: DEFAULT_PORT,
  create: (_values, common) =>
    createRuntime({
      ...(common.adminPrefix !== undefined ? { adminPrefix: common.adminPrefix } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.adminControls !== undefined ? { adminControls: common.adminControls } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }),
  banner: () => ["Synthetic store token: vercel_blob_rw_fixture_fixture"],
}
