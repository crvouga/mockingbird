import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import {
  createRuntime,
  type EventBridgeRuntime,
  type EventBridgeRuntimeOptions,
} from "./runtime.js"
export const DEFAULT_PORT = 12128
export type EventBridgeServerOptions = EventBridgeRuntimeOptions & { port?: number; host?: string }
export const createServer = async (
  options: EventBridgeServerOptions = {},
): Promise<Listening & { runtime: EventBridgeRuntime }> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  return { ...(await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })), runtime }
}
export const serveTarget: ServeTarget = {
  name: "eventbridge",
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
    "Point boto3 events endpoint_url at this server; seed rules through /__admin/state/rules",
  ],
}

export { createServer as createAwsServer } from "./aws-server.js"
