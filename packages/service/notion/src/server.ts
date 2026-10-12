/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type NotionRuntime, type NotionRuntimeOptions } from "./runtime.js"
export const DEFAULT_PORT = 12127
export type NotionServerOptions = NotionRuntimeOptions & { port?: number; host?: string }
export type NotionServer = Listening & { runtime: NotionRuntime }
export const createServer = async (options: NotionServerOptions = {}): Promise<NotionServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })
  return { ...listening, runtime }
}
export const serveTarget: ServeTarget = {
  name: "notion",
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
    "auth: Bearer mock_notion_token; Notion-Version: 2022-06-28",
    "search: POST /v1/search",
  ],
}
