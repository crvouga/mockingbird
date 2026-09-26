/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type PaddleRuntime, type PaddleRuntimeOptions } from "./runtime.js"

/** Port `mockingbird-paddle serve` listens on when none is given. */
export const DEFAULT_PORT = 8795

export type PaddleServerOptions = PaddleRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type PaddleServer = Listening & { runtime: PaddleRuntime }

/**
 * Serve the Paddle mock over `node:http`. Point the SDK at `url`:
 * `new Paddle(key, { environment: url as Environment })`.
 */
export const createServer = async (options: PaddleServerOptions = {}): Promise<PaddleServer> => {
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

/** How `serve` (and `serve --config`) builds the Paddle mock from flags. */
export const serveTarget: ServeTarget = {
  name: "paddle",
  defaultPort: DEFAULT_PORT,
  options: {
    "webhook-url": {
      type: "string",
      value: "<url>",
      description: "Deliver notifications here (e.g. http://127.0.0.1:3000/webhooks/paddle)",
    },
    "webhook-secret": {
      type: "string",
      value: "<pdl_ntfset_…>",
      description: "The notification destination's secret key (the app's PADDLE_WEBHOOK_SECRET)",
    },
    "payment-link": {
      type: "string",
      value: "<url>",
      description: "Default payment link: ready transactions get checkout.url = <url>?_ptxn=<id>",
    },
    fixtures: {
      type: "boolean",
      description:
        "Start every namespace with the fixture account (a customer, catalog and subscriptions)",
    },
  },
  create: (values, common) => {
    const url = text(values["webhook-url"])
    const secret = text(values["webhook-secret"])
    const paymentLink = text(values["payment-link"])
    if (secret && !/^pdl_ntfset_[A-Za-z0-9_]+$/.test(secret)) {
      throw new Error("--webhook-secret must be pdl_ntfset_<key>, as Paddle issues it")
    }
    return createRuntime({
      ...(url ? { webhooks: { url, ...(secret ? { secret } : {}) } } : {}),
      ...(paymentLink ? { paymentLink } : {}),
      ...(values.fixtures === true ? { fixtures: true } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "auth: Authorization: Bearer pdl_sdbx_apikey_… (any key); new Paddle(key, { environment: <this url> })",
    "checkout: POST /__admin/checkout {email, items: [{price_id}]} pays a transaction and creates its subscription",
    "billing: POST /__admin/transactions/:id/pay, /__admin/subscriptions/:id/renew, …/payment-failed",
    "namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<api key>: <ns>}",
  ],
}
