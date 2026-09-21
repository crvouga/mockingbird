/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type PersonaRuntime, type PersonaRuntimeOptions } from "./runtime.js"

/** Port `mockingbird-persona serve` listens on when none is given. */
export const DEFAULT_PORT = 8815

export type PersonaServerOptions = PersonaRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type PersonaServer = Listening & { runtime: PersonaRuntime }

/** Serve the Persona mock over `node:http`. */
export const createServer = async (options: PersonaServerOptions = {}): Promise<PersonaServer> => {
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

/** How `serve` (and `serve --config`) builds the Persona mock from flags. */
export const serveTarget: ServeTarget = {
  name: "persona",
  defaultPort: DEFAULT_PORT,
  options: {
    "webhook-url": {
      type: "string",
      value: "<url>",
      description:
        "Deliver events here (e.g. http://127.0.0.1:4000/v1/identify-verification/webhook)",
    },
    "webhook-secret": {
      type: "string",
      value: "<secret>",
      description: "Signs Persona-Signature (the EMR's PERSONA_WEBHOOK_SECRET)",
    },
    "api-key": {
      type: "string",
      value: "<key>",
      description: "Accept only this bearer key (the EMR's PERSONA_API_KEY); default: any",
    },
  },
  create: (values, common) => {
    const url = text(values["webhook-url"])
    const secret = text(values["webhook-secret"])
    const key = text(values["api-key"])
    return createRuntime({
      ...(url ? { webhooks: { url, ...(secret ? { secret } : {}) } } : {}),
      ...(key ? { settings: { apiKeys: [key] } } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "API: PERSONA_API_URL=<this>/ (POST/GET /inquiries, GET /inquiries/{id}), Authorization: Bearer <key>",
    "hosted flow: PERSONA_WEB_INQUIRY_URL=<this>/verify (or /ns/<name>/verify)",
    "namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<api key>: <ns>}",
  ],
}
