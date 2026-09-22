/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import {
  createRuntime,
  type MediaConvertRuntime,
  type MediaConvertRuntimeOptions,
} from "./runtime.js"
export const DEFAULT_PORT = 8817
export type MediaConvertServerOptions = MediaConvertRuntimeOptions & {
  port?: number
  host?: string
}
export const createServer = async (
  options: MediaConvertServerOptions = {},
): Promise<Listening & { runtime: MediaConvertRuntime }> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })
  if (!options.endpoint) runtime.instance("default").setEndpoint(listening.url)
  return { ...listening, runtime }
}
export const serveTarget: ServeTarget = {
  name: "mediaconvert",
  defaultPort: DEFAULT_PORT,
  create: (_values, common) =>
    createRuntime({
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }),
  banner: () => [
    "Call DescribeEndpoints, then point MediaConvertClient at the returned URL",
    "admin: inspect and transition transcoding jobs",
  ],
}
