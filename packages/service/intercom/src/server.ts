/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type IntercomRuntime, type IntercomRuntimeOptions } from "./runtime.js"

/** Port `mockingbird-intercom serve` listens on when none is given. */
export const DEFAULT_PORT = 8807

export type IntercomServerOptions = IntercomRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type IntercomServer = Listening & { runtime: IntercomRuntime }

/** Serve the Intercom mock over `node:http`. */
export const createServer = async (
  options: IntercomServerOptions = {},
): Promise<IntercomServer> => {
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

/** How `serve` (and `serve --config`) builds the Intercom mock from flags. */
export const serveTarget: ServeTarget = {
  name: "intercom",
  defaultPort: DEFAULT_PORT,
  options: {
    "webhook-url": {
      type: "string",
      value: "<url>",
      description:
        "Backend webhook receiver (e.g. http://127.0.0.1:3000/messaging/webhook); comma-separate several",
    },
    "emr-webhook-url": {
      type: "string",
      value: "<url>",
      description: "EMR webhook receiver (e.g. http://127.0.0.1:4000/v1/webhooks/intercom)",
    },
    "webhook-secret": {
      type: "string",
      value: "<secret>",
      description: "Signs X-Hub-Signature (the app's INTERCOM_WEBHOOK_SECRET)",
    },
    "access-token": {
      type: "string",
      value: "<token>",
      description: "Accept only this bearer token (the app's INTERCOM_ACCESS_TOKEN); default any",
    },
  },
  create: (values, common) => {
    const urls = [text(values["webhook-url"]), text(values["emr-webhook-url"])]
      .filter((value): value is string => value !== undefined)
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean)
    const secret = text(values["webhook-secret"])
    const token = text(values["access-token"])
    return createRuntime({
      ...(urls.length > 0 ? { webhooks: { urls, ...(secret ? { secret } : {}) } } : {}),
      ...(token ? { settings: { tokens: [token] } } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "auth: Authorization: Bearer <INTERCOM_ACCESS_TOKEN>, Intercom-Version: 2.11",
    "namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<token>: <ns>}",
  ],
}
