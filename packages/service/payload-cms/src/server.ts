/// <reference types="node" />
import { readFile } from "node:fs/promises"
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type PayloadCmsRuntime, type PayloadCmsRuntimeOptions } from "./runtime.js"
import type { Seed } from "./state.js"

/** Port `mockingbird-payload-cms serve` listens on when none is given. */
export const DEFAULT_PORT = 8822

export type PayloadCmsServerOptions = PayloadCmsRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type PayloadCmsServer = Listening & { runtime: PayloadCmsRuntime }

/** Serve the Payload CMS mock over `node:http`. */
export const createServer = async (
  options: PayloadCmsServerOptions = {},
): Promise<PayloadCmsServer> => {
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

/** How `serve` (and `serve --config`) builds the Payload CMS mock from flags. */
export const serveTarget: ServeTarget = {
  name: "payload-cms",
  defaultPort: DEFAULT_PORT,
  options: {
    collections: {
      type: "string",
      value: "<file.json>",
      description:
        'Seed collections from a JSON file {"<slug>": [docs…]} instead of the default marketing seed',
    },
  },
  create: async (values, common) => {
    const file = text(values.collections)
    const collections = file ? (JSON.parse(await readFile(file, "utf8")) as Seed) : undefined
    return createRuntime({
      ...(collections ? { collections } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "reads: GET /api/<collection>?where[field][op]=…&limit=&page=&sort=, GET /api/<collection>/<id>",
    "namespaces: x-mockingbird-namespace, or a /ns/<name> suffix on PAYLOAD_CMS_API_URL",
  ],
}
