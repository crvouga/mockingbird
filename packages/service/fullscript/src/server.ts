/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type FullscriptRuntime, type FullscriptRuntimeOptions } from "./runtime.js"

/** Port `mockingbird-fullscript serve` listens on when none is given. */
export const DEFAULT_PORT = 8819

export type FullscriptServerOptions = FullscriptRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type FullscriptServer = Listening & { runtime: FullscriptRuntime }

/** Serve the Fullscript mock over `node:http`. */
export const createServer = async (
  options: FullscriptServerOptions = {},
): Promise<FullscriptServer> => {
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

/** How `serve` (and `serve --config`) builds the Fullscript mock from flags. */
export const serveTarget: ServeTarget = {
  name: "fullscript",
  defaultPort: DEFAULT_PORT,
  options: {
    "webhook-url": {
      type: "string",
      value: "<url>",
      description: "Deliver events here (e.g. http://127.0.0.1:4000/v1/fullscript/webhooks)",
    },
    "webhook-secret": {
      type: "string",
      value: "<secret>",
      description: "Signs Fullscript-Signature (the app's FULLSCRIPT_WEBHOOK_SECRET)",
    },
    "webhook-challenge": {
      type: "string",
      value: "<key>",
      description: "Require the receiver to echo {challenge} (FULLSCRIPT_WEBHOOK_CHALLENGE_KEY)",
    },
    client: {
      type: "string",
      value: "<client_id:client_secret>",
      description:
        "Accept only this OAuth client (FULLSCRIPT_CLIENT_ID:FULLSCRIPT_CLIENT_SECRET); default: any",
    },
    "results-base-url": {
      type: "string",
      value: "<https url>",
      description:
        "Origin for result PDF URLs (the app downloads only https from allowlisted hosts)",
    },
  },
  create: (values, common) => {
    const url = text(values["webhook-url"])
    const secret = text(values["webhook-secret"])
    const challenge = text(values["webhook-challenge"])
    const client = text(values.client)
    const results = text(values["results-base-url"])
    const colon = client?.indexOf(":") ?? -1
    if (client && colon < 1) throw new Error('--client must look like "client_id:client_secret"')
    return createRuntime({
      ...(url
        ? { webhooks: { url, ...(secret ? { secret } : {}), ...(challenge ? { challenge } : {}) } }
        : {}),
      settings: {
        ...(client
          ? {
              clients: [
                { clientId: client.slice(0, colon), clientSecret: client.slice(colon + 1) },
              ],
            }
          : {}),
        ...(results ? { resultsBaseUrl: results } : {}),
      },
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "oauth: GET /oauth/authorize (auto-consents as prac_mock_1), POST /api/oauth/token, POST /api/oauth/revoke",
    "namespaces: x-mockingbird-namespace, or a /ns/<name>/ suffix on FULLSCRIPT_API_URL",
  ],
}
