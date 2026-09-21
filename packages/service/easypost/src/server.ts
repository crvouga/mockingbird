/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type EasyPostRuntime, type EasyPostRuntimeOptions } from "./runtime.js"

/** Port `mockingbird-easypost serve` listens on when none is given. */
export const DEFAULT_PORT = 8818

export type EasyPostServerOptions = EasyPostRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type EasyPostServer = Listening & { runtime: EasyPostRuntime }

/** Serve the EasyPost mock over `node:http`. */
export const createServer = async (
  options: EasyPostServerOptions = {},
): Promise<EasyPostServer> => {
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

/** How `serve` (and `serve --config`) builds the EasyPost mock from flags. */
export const serveTarget: ServeTarget = {
  name: "easypost",
  defaultPort: DEFAULT_PORT,
  options: {
    "api-key": {
      type: "string",
      value: "<key>",
      description: "Accept only this API key (the app's EASYPOST_API_KEY); default: any key",
    },
  },
  create: (values, common) => {
    const key = text(values["api-key"])
    return createRuntime({
      ...(key ? { settings: { apiKeys: [key] } } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "auth: Authorization: Basic base64(<api key>:)",
    "test codes: EZ1000000001 pre_transit … EZ4000000004 delivered … EZ7000000007 unknown",
    "namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<api key>: <ns>}",
  ],
}
