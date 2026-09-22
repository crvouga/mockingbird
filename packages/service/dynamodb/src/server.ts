/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type DynamoRuntime, type DynamoRuntimeOptions } from "./runtime.js"
export const DEFAULT_PORT = 8814
export type DynamoServerOptions = DynamoRuntimeOptions & { port?: number; host?: string }
export const createServer = async (
  options: DynamoServerOptions = {},
): Promise<Listening & { runtime: DynamoRuntime }> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  return { ...(await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })), runtime }
}
export const serveTarget: ServeTarget = {
  name: "dynamodb",
  defaultPort: DEFAULT_PORT,
  create: (_values, common) =>
    createRuntime({
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }),
  banner: () => [
    "AWS SDK endpoint: point DynamoDBClient at this URL",
    "admin: GET /__admin/tables; GET /__admin/items; GET /__admin/streams",
  ],
}
