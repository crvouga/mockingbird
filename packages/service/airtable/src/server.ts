/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { type AirtableRuntime, type AirtableRuntimeOptions, createRuntime } from "./runtime.js"
export const DEFAULT_PORT = 12130
export type AirtableServerOptions = AirtableRuntimeOptions & { port?: number; host?: string }
export type AirtableServer = Listening & { runtime: AirtableRuntime }
export const createServer = async (
  options: AirtableServerOptions = {},
): Promise<AirtableServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })
  return { ...listening, runtime }
}
export const serveTarget: ServeTarget = {
  name: "airtable",
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
  banner: () => ["auth: Bearer mock_airtable_token", "collections: GET /v2/usercollection/workout"],
}
