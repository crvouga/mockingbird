/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type SqsRuntime, type SqsRuntimeOptions } from "./runtime.js"
export const DEFAULT_PORT = 8813
export type SqsServerOptions = SqsRuntimeOptions & { port?: number; host?: string }
export const createServer = async (
  options: SqsServerOptions = {},
): Promise<Listening & { runtime: SqsRuntime }> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  return { ...(await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })), runtime }
}
export const serveTarget: ServeTarget = {
  name: "sqs",
  defaultPort: DEFAULT_PORT,
  create: (_values, common) =>
    createRuntime({
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }),
  banner: () => [
    "AWS SDK endpoint: set SQS_ENDPOINT_URL to this URL",
    "admin: GET /__admin/queues; GET/POST /__admin/messages",
  ],
}
