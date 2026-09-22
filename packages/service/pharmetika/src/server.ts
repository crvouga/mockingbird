/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type PharmetikaRuntime, type PharmetikaRuntimeOptions } from "./runtime.js"
import type { WebhookVariant } from "./state.js"

/** Port `mockingbird-pharmetika serve` listens on when none is given. */
export const DEFAULT_PORT = 8801

export type PharmetikaServerOptions = PharmetikaRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type PharmetikaServer = Listening & { runtime: PharmetikaRuntime }

/** Serve the Pharmetika mock over `node:http`, with auto-advance ticking every 100 ms. */
export const createServer = async (
  options: PharmetikaServerOptions = {},
): Promise<PharmetikaServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime({ tickMs: 100, ...rest })
  const listening = await listen(runtime, {
    port: port ?? 0,
    ...(host !== undefined ? { host } : {}),
  })
  return {
    ...listening,
    runtime,
    close: async () => {
      runtime.stop()
      await listening.close()
    },
  }
}

const text = (value: string | boolean | undefined) =>
  typeof value === "string" ? value : undefined

const VARIANTS = ["workflow_status", "status", "flat"]

/** How `serve` (and `serve --config`) builds the Pharmetika mock from flags. */
export const serveTarget: ServeTarget = {
  name: "pharmetika",
  defaultPort: DEFAULT_PORT,
  options: {
    "webhook-url": {
      type: "string",
      value: "<url>",
      description:
        "Deliver status webhooks here (e.g. http://127.0.0.1:3000/prescriptions/webhooks/pharmetika)",
    },
    "webhook-secret": {
      type: "string",
      value: "<secret>",
      description: "Sent as x-pharmetika-webhook-secret (the app's PHARMETIKA_WEBHOOK_SECRET)",
    },
    "api-token": {
      type: "string",
      value: "<token>",
      description: "Accept only this x-pmk-authentication-token (the app's PHARMETIKA_API_TOKEN)",
    },
    "webhook-variant": {
      type: "string",
      value: "<workflow_status|status|flat>",
      description: "Which receiver field fallback the webhook body uses (default workflow_status)",
    },
    "auto-advance": {
      type: "string",
      value: "<ms:status,status,…>",
      description: 'Walk every new order along a path, e.g. "2000:data_entry,shipped,completed"',
    },
  },
  create: (values, common) => {
    const url = text(values["webhook-url"])
    const secret = text(values["webhook-secret"])
    const token = text(values["api-token"])
    const variant = text(values["webhook-variant"])
    const auto = text(values["auto-advance"])
    const plan = auto ? /^(\d+):(.+)$/.exec(auto) : null
    if (auto && !plan)
      throw new Error('--auto-advance must look like "2000:data_entry,shipped,completed"')
    if (variant && !VARIANTS.includes(variant)) {
      throw new Error(`--webhook-variant must be one of ${VARIANTS.join(", ")}`)
    }
    return createRuntime({
      tickMs: 100,
      ...(url ? { webhooks: { url, ...(secret ? { secret } : {}) } } : {}),
      settings: {
        ...(token ? { tokens: [token] } : {}),
        ...(variant ? { webhookVariant: variant as WebhookVariant } : {}),
        ...(plan
          ? {
              autoAdvance: {
                afterMs: Number(plan[1]),
                path: (plan[2] as string).split(",").map((s) => s.trim()),
              },
            }
          : {}),
      },
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "auth: x-pmk-authentication-token: <token> (catalog also takes Basic or nothing)",
    "namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<token>: <ns>}",
  ],
}
