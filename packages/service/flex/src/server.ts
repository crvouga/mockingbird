/// <reference types="node" />
import { readFileSync } from "node:fs"
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type FlexRuntime, type FlexRuntimeOptions } from "./runtime.js"
import type { ProductRecord } from "./state.js"

/** Port `mockingbird-flex serve` listens on when none is given. */
export const DEFAULT_PORT = 8792

export type FlexServerOptions = FlexRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type FlexServer = Listening & { runtime: FlexRuntime }

/** Serve the Flex mock over `node:http`, expiring due sessions every 100 ms. */
export const createServer = async (options: FlexServerOptions = {}): Promise<FlexServer> => {
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

function readCorpus(path: string): ProductRecord[] {
  const data = JSON.parse(readFileSync(path, "utf8"))
  if (
    !Array.isArray(data) ||
    !data.every((p) => p && typeof p.product_id === "string" && typeof p.name === "string")
  ) {
    throw new Error("Invalid --corpus file: expected an array of Flex product records")
  }
  return data
}

/** How `serve` (and `serve --config`) builds the Flex mock from flags. */
export const serveTarget: ServeTarget = {
  name: "flex",
  defaultPort: DEFAULT_PORT,
  options: {
    corpus: {
      type: "string",
      value: "<file>",
      description: "Serve a private ProductRecord array from JSON",
    },
    "webhook-url": {
      type: "string",
      value: "<url>",
      description: "Deliver webhooks here (e.g. http://127.0.0.1:3000/billing/webhooks/flex)",
    },
    "webhook-secret": {
      type: "string",
      value: "<fwhsec_…|whsec_…>",
      description: "Svix signing secret (the app's FLEX_WEBHOOK_SECRET)",
    },
    "public-url": {
      type: "string",
      value: "<url>",
      description: "Base URL of the hosted page in session URLs (default: the request origin)",
    },
    "event-naming": {
      type: "string",
      value: "<dotted|underscored>",
      description: "Send checkout.session.* (dotted, default) or the checkout_session.* aliases",
    },
  },
  create: (values, common) => {
    const path = text(values.corpus)
    const url = text(values["webhook-url"])
    const secret = text(values["webhook-secret"])
    const publicUrl = text(values["public-url"])
    const naming = text(values["event-naming"])
    if (naming && naming !== "dotted" && naming !== "underscored") {
      throw new Error("--event-naming must be dotted or underscored")
    }
    return createRuntime({
      ...(path ? { products: readCorpus(path) } : {}),
      tickMs: 100,
      ...(url ? { webhooks: { url, ...(secret ? { secret } : {}) } } : {}),
      settings: {
        ...(publicUrl ? { publicUrl } : {}),
        ...(naming ? { eventNaming: naming as "dotted" | "underscored" } : {}),
      },
      ...(common.adminPrefix !== undefined ? { adminPrefix: common.adminPrefix } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.adminControls !== undefined ? { adminControls: common.adminControls } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "auth: Authorization: Bearer fsk_test_… (test mode) or fsk_… (live mode)",
    "hosted page: GET /pay/<checkout_session_id> (cards 4000051230000072 HSA, 4242424242424242, 4000000000000002 declines)",
    "namespaces: x-mockingbird-namespace, /__admin/ns/<name>/…, or PUT /__admin/credentials {<FLEX_API_KEY>: <ns>}",
  ],
}
