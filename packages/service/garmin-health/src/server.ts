/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import {
  createRuntime,
  type GarminHealthRuntime,
  type GarminHealthRuntimeOptions,
} from "./runtime.js"

export const DEFAULT_PORT = 12131
export type GarminHealthServerOptions = GarminHealthRuntimeOptions & {
  port?: number
  host?: string
}
export type GarminHealthServer = Listening & { runtime: GarminHealthRuntime }
export const createServer = async (
  options: GarminHealthServerOptions = {},
): Promise<GarminHealthServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })
  return { ...listening, runtime }
}
export const serveTarget: ServeTarget = {
  name: "garmin-health",
  defaultPort: DEFAULT_PORT,
  options: {
    "webhook-base-url": {
      type: "string",
      value: "<url>",
      description: "The consumer's webhook base URL (push, ping, deregistration, permissions)",
    },
    "webhook-client-id": {
      type: "string",
      value: "<id>",
      description: "Value of the garmin-client-id header on webhook deliveries",
    },
  },
  create: (values, common) => {
    const baseUrl = values["webhook-base-url"]
    const clientId = values["webhook-client-id"]
    return createRuntime({
      ...(typeof baseUrl === "string"
        ? { webhooks: { baseUrl, ...(typeof clientId === "string" ? { clientId } : {}) } }
        : {}),
      ...(common.adminPrefix !== undefined ? { adminPrefix: common.adminPrefix } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.adminControls !== undefined ? { adminControls: common.adminControls } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "auth: Bearer mock_garmin_token",
    "consent: GET /oauth2Confirm  token: POST /di-oauth2-service/oauth/token",
    "backfill: GET /wellness-api/rest/backfill/sleeps?summaryStartTimeInSeconds=1767225600&summaryEndTimeInSeconds=1767312000",
  ],
}
