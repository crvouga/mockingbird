import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type WorkOSRuntime, type WorkOSRuntimeOptions } from "./runtime.js"
export const DEFAULT_PORT = 12128
export const createServer = async (
  options: WorkOSRuntimeOptions & { port?: number; host?: string } = {},
): Promise<Listening & { runtime: WorkOSRuntime }> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  return { ...(await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })), runtime }
}
export const serveTarget: ServeTarget = {
  name: "workos",
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
  banner: () => [
    "AuthKit: WORKOS_API_HOSTNAME=127.0.0.1 WORKOS_API_HTTPS=false WORKOS_API_PORT=<port>",
    "Default client: client_mock; API key: mock_workos_key; callback: http://localhost:3000/callback",
  ],
}
