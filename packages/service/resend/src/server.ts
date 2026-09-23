/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type ResendRuntime, type ResendRuntimeOptions } from "./runtime.js"

/** Port `mockingbird-resend serve` listens on when none is given. */
export const DEFAULT_PORT = 8794

export type ResendServerOptions = ResendRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type ResendServer = Listening & { runtime: ResendRuntime }

/** Serve the Resend mock over `node:http`. Point `RESEND_BASE_URL` at `url` before importing `resend`. */
export const createServer = async (options: ResendServerOptions = {}): Promise<ResendServer> => {
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

/** How `serve` (and `serve --config`) builds the Resend mock from flags. */
export const serveTarget: ServeTarget = {
  name: "resend",
  defaultPort: DEFAULT_PORT,
  options: {
    "webhook-url": {
      type: "string",
      value: "<url>",
      description:
        "Deliver email.received webhooks here (e.g. http://127.0.0.1:3000/messaging/inbound/email)",
    },
    "webhook-secret": {
      type: "string",
      value: "<whsec_…>",
      description: "Svix signing secret (the app's RESEND_INBOUND_WEBHOOK_SECRET)",
    },
    "forward-to-inbox": {
      type: "string",
      value: "<url>",
      description:
        "Copy every sent email into a Mailosaur mock (its POST /__admin/ingest), e.g. http://127.0.0.1:8793",
    },
  },
  create: (values, common) => {
    const url = text(values["webhook-url"])
    const secret = text(values["webhook-secret"])
    const inbox = text(values["forward-to-inbox"])
    if (secret && !/^whsec_[A-Za-z0-9+/=]+$/.test(secret)) {
      throw new Error("--webhook-secret must be whsec_<base64>, as Resend issues it")
    }
    return createRuntime({
      ...(url ? { webhooks: { url, ...(secret ? { secret } : {}) } } : {}),
      ...(inbox
        ? {
            forwardToInbox: {
              url: inbox,
              ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
            },
          }
        : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "auth: Authorization: Bearer re_… (any key); set RESEND_BASE_URL before importing resend",
    "outbox: GET /__admin/outbox?to=&tag=category:<v>, GET /__admin/outbox/:id/links",
    "inbound: POST /__admin/inbound {from, to, subject, text?, html?, attachments?} → email.received",
    "namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<api key>: <ns>}",
  ],
}
