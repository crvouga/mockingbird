import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import {
  type AppStoreConnectRuntime,
  type AppStoreConnectRuntimeOptions,
  createRuntime,
} from "./runtime.js"
export const DEFAULT_PORT = 12130
export const createServer = async (
  options: AppStoreConnectRuntimeOptions & { port?: number; host?: string } = {},
): Promise<Listening & { runtime: AppStoreConnectRuntime }> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  return { ...(await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })), runtime }
}
export const serveTarget: ServeTarget = {
  name: "app-store-connect",
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
  banner: () => ["Seed a mock public ES256 JWK and issuer/key id; authenticate with a signed JWT"],
}
