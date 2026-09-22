/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type S3Runtime, type S3RuntimeOptions } from "./runtime.js"
export const DEFAULT_PORT = 8812
export type S3ServerOptions = S3RuntimeOptions & { port?: number; host?: string }
export const createServer = async (
  options: S3ServerOptions = {},
): Promise<Listening & { runtime: S3Runtime }> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  return { ...(await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })), runtime }
}
export const serveTarget: ServeTarget = {
  name: "s3",
  defaultPort: DEFAULT_PORT,
  create: (_values, common) =>
    createRuntime({
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }),
  banner: () => [
    "AWS SDK endpoint: set forcePathStyle=true and endpoint to this URL",
    "admin: POST /__admin/objects; GET /__admin/objects",
  ],
}
