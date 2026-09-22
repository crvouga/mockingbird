/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { type AwsSecretsRuntime, type AwsSecretsRuntimeOptions, createRuntime } from "./runtime.js"
export const DEFAULT_PORT = 8815
export type AwsSecretsServerOptions = AwsSecretsRuntimeOptions & { port?: number; host?: string }
export const createServer = async (
  options: AwsSecretsServerOptions = {},
): Promise<Listening & { runtime: AwsSecretsRuntime }> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  return { ...(await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })), runtime }
}
export const serveTarget: ServeTarget = {
  name: "aws-secrets",
  defaultPort: DEFAULT_PORT,
  create: (_values, common) =>
    createRuntime({
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }),
  banner: () => [
    "Point SecretsManagerClient and SSMClient endpoints at this URL",
    "admin values are always redacted",
  ],
}
