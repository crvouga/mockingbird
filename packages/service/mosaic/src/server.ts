/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type MosaicRuntime, type MosaicRuntimeOptions } from "./runtime.js"

export const DEFAULT_PORT = 8931
export type MosaicServerOptions = MosaicRuntimeOptions & { port?: number; host?: string }
export type MosaicServer = Listening & { runtime: MosaicRuntime }

export const createServer = async (options: MosaicServerOptions = {}): Promise<MosaicServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const server = await listen(runtime, { port: port ?? 0, ...(host === undefined ? {} : { host }) })
  return { ...server, runtime }
}

export const serveTarget: ServeTarget = {
  name: "mosaic",
  defaultPort: DEFAULT_PORT,
  options: {},
  create: (_values, { adminControls, adminKey, adminPrefix, onLog, seed }) =>
    createRuntime({
      ...(adminControls === undefined ? {} : { adminControls }),
      ...(adminKey === undefined ? {} : { adminKey }),
      ...(adminPrefix === undefined ? {} : { adminPrefix }),
      ...(onLog === undefined ? {} : { onLog }),
      ...(seed === undefined ? {} : { seed }),
    }),
  banner: () => [
    "auth: ApiKey with any non-empty value",
    "lifecycle: POST /__admin/lines/:id/transition",
  ],
}
