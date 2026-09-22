/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import {
  createRuntime,
  type StepFunctionsRuntime,
  type StepFunctionsRuntimeOptions,
} from "./runtime.js"
export const DEFAULT_PORT = 8816
export type StepFunctionsServerOptions = StepFunctionsRuntimeOptions & {
  port?: number
  host?: string
}
export const createServer = async (
  options: StepFunctionsServerOptions = {},
): Promise<Listening & { runtime: StepFunctionsRuntime }> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  return { ...(await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })), runtime }
}
export const serveTarget: ServeTarget = {
  name: "step-functions",
  defaultPort: DEFAULT_PORT,
  create: (_values, common) =>
    createRuntime({
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }),
  banner: () => [
    "Point SFNClient endpoint at this URL",
    "admin: register state machines and transition executions",
  ],
}
