/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import {
  createRuntime,
  DEFAULT_WEBHOOK_IP,
  type HealthieRuntime,
  type HealthieRuntimeOptions,
} from "./runtime.js"

/** Port `mockingbird-healthie serve` listens on when none is given. */
export const DEFAULT_PORT = 8816

export type HealthieServerOptions = HealthieRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type HealthieServer = Listening & { runtime: HealthieRuntime }

/** Serve the Healthie mock over `node:http`. */
export const createServer = async (
  options: HealthieServerOptions = {},
): Promise<HealthieServer> => {
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

/** How `serve` (and `serve --config`) builds the Healthie mock from flags. */
export const serveTarget: ServeTarget = {
  name: "healthie",
  defaultPort: DEFAULT_PORT,
  options: {
    "webhook-base-url": {
      type: "string",
      value: "<url>",
      description:
        "Our backend's base URL; webhooks go to <url>/users/webhook/status and <url>/forms/webhooks/status",
    },
    "webhook-ip": {
      type: "string",
      value: "<ip>",
      description: `Sent as x-forwarded-for (must be in HEALTHIE_WEBHOOK_IP_ADDRESS; default ${DEFAULT_WEBHOOK_IP})`,
    },
    "api-key": {
      type: "string",
      value: "<key>",
      description: "The organization API key to accept (the app's HEALTHIE_API_AUTH_TOKEN)",
    },
    "sign-in-namespace": {
      type: "string",
      value: "<name>",
      description: "Require this signIn namespace (the app's HEALTHIE_NAMESPACE)",
    },
  },
  create: (values, common) => {
    const base = text(values["webhook-base-url"])
    const ip = text(values["webhook-ip"])
    const key = text(values["api-key"])
    const signInNamespace = text(values["sign-in-namespace"])
    return createRuntime({
      ...(base ? { webhooks: { baseUrl: base, ...(ip ? { ip } : {}) } } : {}),
      settings: {
        ...(key ? { orgApiKeys: [key] } : {}),
        ...(signInNamespace ? { namespace: signInNamespace } : {}),
      },
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "GraphQL: POST /graphql (JSON or multipart), Authorization: Bearer|Basic <api key>, AuthorizationSource: API",
    "namespaces: x-mockingbird-namespace, /ns/<name>/graphql, or PUT /__admin/credentials {<api key>: <ns>}",
  ],
}
