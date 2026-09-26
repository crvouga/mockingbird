/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type FormbricksRuntime, type FormbricksRuntimeOptions } from "./runtime.js"
import { DEFAULT_SETTINGS } from "./state.js"

/** Port `mockingbird-formbricks serve` listens on when none is given. */
export const DEFAULT_PORT = 8813

export type FormbricksServerOptions = FormbricksRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type FormbricksServer = Listening & { runtime: FormbricksRuntime }

/** Serve the Formbricks mock over `node:http`. */
export const createServer = async (
  options: FormbricksServerOptions = {},
): Promise<FormbricksServer> => {
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

/** How `serve` (and `serve --config`) builds the Formbricks mock from flags. */
export const serveTarget: ServeTarget = {
  name: "formbricks",
  defaultPort: DEFAULT_PORT,
  options: {
    "webhook-url": {
      type: "string",
      value: "<url>",
      description: "Deliver webhooks here (e.g. http://127.0.0.1:3000/webhooks/formbricks)",
    },
    "webhook-token": {
      type: "string",
      value: "<token>",
      description: "Appended to the webhook url as ?token= (for receivers that check one)",
    },
    "webhook-secret": {
      type: "string",
      value: "<whsec_…>",
      description: "Standard Webhooks key that signs webhook-signature (optional)",
    },
    "workspace-id": {
      type: "string",
      value: "<id>",
      description: "An extra workspace id that serves the survey corpus",
    },
  },
  create: (values, common) => {
    const url = text(values["webhook-url"])
    const token = text(values["webhook-token"])
    const secret = text(values["webhook-secret"])
    const workspace = text(values["workspace-id"])
    const target =
      url && token
        ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`
        : url
    return createRuntime({
      ...(target ? { webhooks: { url: target, ...(secret ? { secret } : {}) } } : {}),
      ...(workspace
        ? { settings: { workspaces: [workspace, ...DEFAULT_SETTINGS.workspaces] } }
        : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    `point the SDK's appUrl at this url; workspace ${DEFAULT_SETTINGS.workspaces[0]} (legacy environment ${Object.keys(DEFAULT_SETTINGS.legacyEnvironmentIds)[0]}) serves the survey corpus`,
    "management API: x-api-key <any>; namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<workspace id | api key>: <ns>}",
  ],
}
