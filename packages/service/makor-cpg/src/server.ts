/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type MakorCpgRuntime, type MakorCpgRuntimeOptions } from "./runtime.js"

/** Port `mockingbird-makor-cpg serve` listens on when none is given. */
export const DEFAULT_PORT = 8806

export type MakorCpgServerOptions = MakorCpgRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type MakorCpgServer = Listening & { runtime: MakorCpgRuntime }

/** Serve the Makor CPG mock over `node:http` (CORS included, for the browser-direct EMR). */
export const createServer = async (
  options: MakorCpgServerOptions = {},
): Promise<MakorCpgServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, {
    port: port ?? 0,
    ...(host !== undefined ? { host } : {}),
  })
  return { ...listening, runtime }
}

const text = (value: string | boolean | undefined) =>
  typeof value === "string" ? value : undefined

/** How `serve` (and `serve --config`) builds the Makor CPG mock from flags. */
export const serveTarget: ServeTarget = {
  name: "makor-cpg",
  defaultPort: DEFAULT_PORT,
  options: {
    "api-key": {
      type: "string",
      value: "<key>",
      description:
        "Accept only this x-api-key (the app's MAKOR_AI_API_KEY / NEXT_PUBLIC_MAKOR_API_KEY); default any",
    },
    "processing-ms": {
      type: "string",
      value: "<ms>",
      description: "Mock-clock ms a generated review script stays 'processing' (default 0)",
    },
  },
  create: (values, common) => {
    const key = text(values["api-key"])
    const processing = text(values["processing-ms"])
    if (processing !== undefined && !/^\d+$/.test(processing)) {
      throw new Error("--processing-ms must be a whole number of milliseconds")
    }
    return createRuntime({
      settings: {
        ...(key ? { apiKeys: [key] } : {}),
        ...(processing !== undefined ? { processingMs: Number(processing) } : {}),
      },
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "auth: x-api-key: <MAKOR_AI_API_KEY>; CORS: every origin (browser-direct EMR calls)",
    "namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<api key>: <ns>}",
  ],
}
