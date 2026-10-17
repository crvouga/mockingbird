/// <reference types="node" />
import {
  type Listening,
  listen,
  providerServeOptions,
  providerServeValues,
  type ServeTarget,
} from "@crvouga/mockingbird-adapter-node"
import { type CognitoRuntime, type CognitoRuntimeOptions, createRuntime } from "./runtime.js"
export const DEFAULT_PORT = 8811
export type CognitoServerOptions = CognitoRuntimeOptions & { port?: number; host?: string }
export const createServer = async (
  options: CognitoServerOptions = {},
): Promise<Listening & { runtime: CognitoRuntime }> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  return { ...(await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })), runtime }
}
export const serveTarget: ServeTarget = {
  name: "cognito",
  defaultPort: DEFAULT_PORT,
  options: {
    ...providerServeOptions,
    "pool-id": { type: "string", value: "<id>", description: "User pool id" },
    "client-id": { type: "string", value: "<id>", description: "App client id" },
    region: { type: "string", value: "<region>", description: "AWS region (default us-east-1)" },
  },
  create: async (values, common) =>
    createRuntime({
      ...(await providerServeValues<NonNullable<CognitoRuntimeOptions["fixtures"]>>(
        values,
        common,
      )),
      ...(typeof values["pool-id"] === "string" ? { poolId: values["pool-id"] } : {}),
      ...(typeof values["client-id"] === "string" ? { clientId: values["client-id"] } : {}),
      ...(typeof values.region === "string" ? { region: values.region } : {}),
      ...(common.adminPrefix !== undefined ? { adminPrefix: common.adminPrefix } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.adminControls !== undefined ? { adminControls: common.adminControls } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }),
  banner: () => [
    "AWS SDK endpoint: set COGNITO_ENDPOINT to this URL",
    "admin: POST /__admin/users; GET /__admin/codes?username=…",
  ],
}
