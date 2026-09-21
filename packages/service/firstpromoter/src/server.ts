/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import {
  createRuntime,
  type FirstPromoterRuntime,
  type FirstPromoterRuntimeOptions,
} from "./runtime.js"

/** Port `mockingbird-firstpromoter serve` listens on when none is given. */
export const DEFAULT_PORT = 8812

export type FirstPromoterServerOptions = FirstPromoterRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type FirstPromoterServer = Listening & { runtime: FirstPromoterRuntime }

/** Serve the FirstPromoter mock over `node:http`. */
export const createServer = async (
  options: FirstPromoterServerOptions = {},
): Promise<FirstPromoterServer> => {
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

/** How `serve` (and `serve --config`) builds the FirstPromoter mock from flags. */
export const serveTarget: ServeTarget = {
  name: "firstpromoter",
  defaultPort: DEFAULT_PORT,
  options: {
    "webhook-url": {
      type: "string",
      value: "<url>",
      description:
        "Deliver webhooks here (e.g. http://127.0.0.1:3000/users/webhooks/first-promoter)",
    },
    "webhook-secret": {
      type: "string",
      value: "<user:pass>",
      description: "Sent as Authorization: Basic (FIRST_PROMOTER_WEBHOOK_AUTH_USERNAME:…_PASSWORD)",
    },
  },
  create: (values, common) => {
    const url = text(values["webhook-url"])
    const secret = text(values["webhook-secret"])
    return createRuntime({
      ...(url ? { webhooks: { url, ...(secret ? { secret } : {}) } } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "auth: Authorization: Bearer <FIRST_PROMOTER_API_KEY> and Account-ID: <FIRST_PROMOTER_ACCOUNT_ID>",
    "namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<api key>: <ns>}",
  ],
}
