/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { type AhaRuntime, type AhaRuntimeOptions, createRuntime } from "./runtime.js"
import type { Settings } from "./state.js"

/** Port `mockingbird-aha serve` listens on when none is given. */
export const DEFAULT_PORT = 8799

export type AhaServerOptions = AhaRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type AhaServer = Listening & { runtime: AhaRuntime }

/** Serve the AHA mock over `node:http`, with `autoSchedule` ticking every 100 ms. */
export const createServer = async (options: AhaServerOptions = {}): Promise<AhaServer> => {
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

/** How `serve` (and `serve --config`) builds the AHA mock from flags. */
export const serveTarget: ServeTarget = {
  name: "aha",
  defaultPort: DEFAULT_PORT,
  options: {
    "webhook-url": {
      type: "string",
      value: "<url>",
      description: "Deliver webhooks here (e.g. http://127.0.0.1:3000/bloodwork/aha-webhook)",
    },
    "webhook-secret": {
      type: "string",
      value: "<secret>",
      description: "Sent as Authorization: Token <secret> (the app's AHA_WEBHOOK_SECRET)",
    },
    "api-key": {
      type: "string",
      value: "<key>",
      description: "Only accept this AHA_API_KEY (default: any key)",
    },
    "api-secret": {
      type: "string",
      value: "<secret>",
      description: "Verify X-SIGNATURE exactly with this AHA_API_SECRET (needs --api-key)",
    },
    envelope: {
      type: "string",
      value: "<raw|wrapped>",
      description: "Success envelope: raw {content,message,status} (default) or {success,data}",
    },
    "auto-schedule": {
      type: "string",
      value: "<ms>",
      description: "Emit Scheduled this many ms (mock clock) after each create-order",
    },
  },
  create: (values, common) => {
    const url = text(values["webhook-url"])
    const secret = text(values["webhook-secret"])
    const apiKey = text(values["api-key"])
    const apiSecret = text(values["api-secret"])
    const envelope = text(values.envelope)
    const auto = text(values["auto-schedule"])
    if (envelope !== undefined && envelope !== "raw" && envelope !== "wrapped") {
      throw new Error("--envelope must be raw or wrapped")
    }
    if (auto !== undefined && !/^\d+$/.test(auto)) throw new Error("--auto-schedule must be ms")
    if (apiSecret !== undefined && apiKey === undefined) {
      throw new Error("--api-secret needs --api-key")
    }
    const settings: Partial<Settings> = {
      ...(envelope ? { envelope } : {}),
      ...(apiKey ? { credentials: [{ apiKey, ...(apiSecret ? { apiSecret } : {}) }] } : {}),
      ...(auto !== undefined ? { autoSchedule: { afterMs: Number(auto) } } : {}),
    }
    return createRuntime({
      tickMs: 100,
      ...(url ? { webhooks: { url, ...(secret ? { secret } : {}) } } : {}),
      settings,
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "auth: X-API-KEY + X-TIMESTAMP + X-SIGNATURE (HMAC), or legacy X-Geviti-Auth-Key",
    "webhooks: POST /__admin/orders/<GV-n>/transition {status, drawStatus?, scheduledAt?, timeZone?}",
    "namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<AHA_API_KEY>: <ns>}",
  ],
}
