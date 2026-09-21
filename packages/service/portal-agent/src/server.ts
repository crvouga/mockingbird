/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import {
  createRuntime,
  type PortalAgentRuntime,
  type PortalAgentRuntimeOptions,
} from "./runtime.js"

/** Port `mockingbird-portal-agent serve` listens on when none is given. */
export const DEFAULT_PORT = 8804

export type PortalAgentServerOptions = PortalAgentRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type PortalAgentServer = Listening & { runtime: PortalAgentRuntime }

/** Serve the portal-agent mock over `node:http`. */
export const createServer = async (
  options: PortalAgentServerOptions = {},
): Promise<PortalAgentServer> => {
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

/** How `serve` (and `serve --config`) builds the portal-agent mock from flags. */
export const serveTarget: ServeTarget = {
  name: "portal-agent",
  defaultPort: DEFAULT_PORT,
  options: {
    "webhook-url": {
      type: "string",
      value: "<url>",
      description:
        "Deliver job callbacks here (e.g. http://127.0.0.1:3000/prescriptions/webhooks/portal-agent)",
    },
    "callback-key": {
      type: "string",
      value: "<key>",
      description: "Sent as x-internal-key (the app's ERX_PORTAL_AGENT_CALLBACK_KEY)",
    },
    "api-key": {
      type: "string",
      value: "<key>",
      description: "The only bearer key to accept (the app's ERX_PORTAL_AGENT_API_KEY)",
    },
  },
  create: (values, common) => {
    const url = text(values["webhook-url"])
    const secret = text(values["callback-key"])
    const apiKey = text(values["api-key"])
    return createRuntime({
      ...(url ? { webhooks: { url, ...(secret ? { secret } : {}) } } : {}),
      ...(apiKey ? { settings: { apiKeys: [apiKey] } } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "auth: Authorization: Bearer <ERX_PORTAL_AGENT_API_KEY>",
    "complete a job: POST /__admin/jobs/<agentJobId>/complete {status, fulfillmentStatus?, …}",
    "namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<api key>: <ns>}",
  ],
}
