/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type GeneByGeneRuntime, type GeneByGeneRuntimeOptions } from "./runtime.js"

/** Port `mockingbird-genebygene serve` listens on when none is given. */
export const DEFAULT_PORT = 8788

export type GeneByGeneServerOptions = GeneByGeneRuntimeOptions & {
  /** Default `0`: the OS picks a free port (read it from `url` / `port`). */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type GeneByGeneServer = Listening & { runtime: GeneByGeneRuntime }

/** Serve the GeneByGene mock over `node:http`. Resolves once it is listening. */
export const createServer = async (
  options: GeneByGeneServerOptions = {},
): Promise<GeneByGeneServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, {
    port: port ?? 0,
    ...(host !== undefined ? { host } : {}),
  })
  return { ...listening, runtime }
}

/** How `serve` (and `serve --config`) builds the GeneByGene mock from flags. */
export const serveTarget: ServeTarget = {
  name: "genebygene",
  defaultPort: DEFAULT_PORT,
  create: (_values, common) =>
    createRuntime({
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }),
  banner: () => [
    "auth: POST /connect/token (any client id/secret), then Authorization: Bearer <token>",
  ],
}
