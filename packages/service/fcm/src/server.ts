/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type FcmRuntime, type FcmRuntimeOptions } from "./runtime.js"

/** Port `mockingbird-fcm serve` listens on when none is given. */
export const DEFAULT_PORT = 8826

export type FcmServerOptions = FcmRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type FcmServer = Listening & { runtime: FcmRuntime }

/** Serve the FCM mock over `node:http`. */
export const createServer = async (options: FcmServerOptions = {}): Promise<FcmServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, {
    port: port ?? 0,
    ...(host !== undefined ? { host } : {}),
  })
  return { ...listening, runtime }
}

/** How `serve` builds the FCM mock from flags. */
export const serveTarget: ServeTarget = {
  name: "fcm",
  defaultPort: DEFAULT_PORT,
  options: {
    strict: {
      type: "boolean",
      description:
        "Reject bearers that are not mapped to a project (default: any bearer is accepted)",
    },
  },
  create: (values, common) =>
    createRuntime({
      ...(values.strict === true ? { settings: { strict: true } } : {}),
      ...(common.adminPrefix !== undefined ? { adminPrefix: common.adminPrefix } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.adminControls !== undefined ? { adminControls: common.adminControls } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }),
  banner: () => [
    "send: POST <this>/v1/projects/demo-project/messages:send  Authorization: Bearer fixture-token",
    "firebase-admin hardcodes fcm.googleapis.com; use createAdminTransport from @crvouga/mockingbird-service-fcm/admin and messaging.enableLegacyHttpTransport()",
    "fixture device token: fixture-device-token (android, project demo-project)",
    "outbox: GET /__admin/outbox   inbox: GET /__admin/inbox/<token>",
  ],
}
