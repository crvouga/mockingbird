/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type PrismRuntime, type PrismRuntimeOptions } from "./runtime.js"

/** Port `mockingbird-prism serve` listens on when none is given. */
export const DEFAULT_PORT = 8825

export type PrismServerOptions = PrismRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type PrismServer = Listening & { runtime: PrismRuntime }

/** Serve the Prism mock over `node:http`, with auto-advance ticking every 100 ms. */
export const createServer = async (options: PrismServerOptions = {}): Promise<PrismServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime({ tickMs: 100, ...rest })
  const listening = await listen(runtime, {
    port: port ?? 0,
    ...(host !== undefined ? { host } : {}),
  })
  return {
    ...listening,
    runtime,
    close: async () => {
      runtime.stop()
      await listening.close()
    },
  }
}

const text = (value: string | boolean | undefined) =>
  typeof value === "string" ? value : undefined

/** How `serve` (and `serve --config`) builds the Prism mock from flags. */
export const serveTarget: ServeTarget = {
  name: "prism",
  defaultPort: DEFAULT_PORT,
  options: {
    "api-key": {
      type: "string",
      value: "<key>",
      description: "Accept only this bearer key (the app's PRISM_API_KEY); default: any",
    },
    "auto-advance": {
      type: "string",
      value: "<ms>",
      description: "Walk uploaded scans through each processing stage every <ms> to READY",
    },
  },
  create: (values, common) => {
    const key = text(values["api-key"])
    const auto = text(values["auto-advance"])
    if (auto !== undefined && !/^\d+$/.test(auto)) throw new Error("--auto-advance must be ms")
    return createRuntime({
      tickMs: 100,
      settings: {
        ...(key ? { apiKeys: [key] } : {}),
        ...(auto ? { autoAdvance: { afterMs: Number(auto) } } : {}),
      },
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "auth: Authorization: Bearer <PRISM_API_KEY>, Accept: application/json;v=1",
    "namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<api key>: <ns>}",
  ],
}
