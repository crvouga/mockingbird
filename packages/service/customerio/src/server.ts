/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { type CustomerIoRuntime, type CustomerIoRuntimeOptions, createRuntime } from "./runtime.js"

/** Port `mockingbird-customerio serve` listens on when none is given. */
export const DEFAULT_PORT = 8810

export type CustomerIoServerOptions = CustomerIoRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type CustomerIoServer = Listening & { runtime: CustomerIoRuntime }

/** Serve the Customer.io mock (CDP, App API and click tracking) over `node:http`. */
export const createServer = async (
  options: CustomerIoServerOptions = {},
): Promise<CustomerIoServer> => {
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

/** How `serve` (and `serve --config`) builds the Customer.io mock from flags. */
export const serveTarget: ServeTarget = {
  name: "customerio",
  defaultPort: DEFAULT_PORT,
  options: {
    "webhook-url": {
      type: "string",
      value: "<url>",
      description:
        "Deliver reporting events here (e.g. http://127.0.0.1:3000/v1/customer-io/reporting-webhook)",
    },
    "webhook-secret": {
      type: "string",
      value: "<secret>",
      description: "Signs x-cio-signature (the app's CUSTOMERIO_REPORTING_WEBHOOK_SIGNING_KEY)",
    },
    "strict-messages": {
      type: "boolean",
      description: "Refuse sends whose transactional_message_id is not in the workspace catalog",
    },
    "tracking-base": {
      type: "string",
      value: "<url>",
      description: "Base of rewritten tracked links (default https://links.customer.io)",
    },
  },
  create: (values, common) => {
    const url = text(values["webhook-url"])
    const secret = text(values["webhook-secret"])
    const trackingBase = text(values["tracking-base"])
    return createRuntime({
      ...(url ? { webhooks: { url, ...(secret ? { secret } : {}) } } : {}),
      settings: {
        ...(values["strict-messages"] === true ? { strictMessages: true } : {}),
        ...(trackingBase ? { trackingBase } : {}),
      },
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "CDP: POST /v1/identify|track|batch with Basic <write key>: (the SDK's host)",
    "App API: POST /v1/send/email|sms|inbox_message, GET /v1/transactional with Bearer <app key>",
    "namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<key>: <ns>}",
  ],
}
