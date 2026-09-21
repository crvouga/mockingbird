/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type OdxRuntime, type OdxRuntimeOptions } from "./runtime.js"

/** Port `mockingbird-odx serve` listens on when none is given. */
export const DEFAULT_PORT = 8817

export type OdxServerOptions = OdxRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type OdxServer = Listening & { runtime: OdxRuntime }

/** Serve the ODX mock over `node:http`. */
export const createServer = async (options: OdxServerOptions = {}): Promise<OdxServer> => {
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

/** How `serve` (and `serve --config`) builds the ODX mock from flags. */
export const serveTarget: ServeTarget = {
  name: "odx",
  defaultPort: DEFAULT_PORT,
  options: {
    "webhook-url": {
      type: "string",
      value: "<url>",
      description:
        "Pre-register a webhook (e.g. http://127.0.0.1:3000/odx/webhook; must equal SYSTEM_API_DEPLOYMENT_URL/odx/webhook)",
    },
    "signing-key": {
      type: "string",
      value: "<key>",
      description:
        "Its signing key (random when omitted; our guard fetches it from GET /v1/webhooks)",
    },
    "api-key": {
      type: "string",
      value: "<key>",
      description: "Accept only this ApiKey (the app's OPTIMAL_API_KEY); any key when omitted",
    },
  },
  create: (values, common) => {
    const url = text(values["webhook-url"])
    const signingKey = text(values["signing-key"])
    const apiKey = text(values["api-key"])
    return createRuntime({
      ...(url ? { webhook: { url, ...(signingKey ? { signingKey } : {}) } } : {}),
      ...(apiKey ? { settings: { apiKeys: [apiKey] } } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "auth: header ApiKey: <OPTIMAL_API_KEY>; point OPTIMAL_URL at this server",
    "namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<ApiKey>: <ns>}",
  ],
}
