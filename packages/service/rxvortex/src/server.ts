/// <reference types="node" />
import { readFileSync } from "node:fs"
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { type CatalogItem, parseCatalog } from "./catalog.js"
import { createRuntime, type RxVortexRuntime, type RxVortexRuntimeOptions } from "./runtime.js"

/** Port `mockingbird-rxvortex serve` listens on when none is given. */
export const DEFAULT_PORT = 8791

export type RxVortexServerOptions = RxVortexRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type RxVortexServer = Listening & { runtime: RxVortexRuntime }

/** Serve the RxVortex mock over `node:http`, with auto-advance ticking every 100 ms. */
export const createServer = async (
  options: RxVortexServerOptions = {},
): Promise<RxVortexServer> => {
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

/**
 * Read a catalog file: a JSON array of rows, or the `{data: [...]}` body
 * `GET /api/v1/preset-catalog-items` answers with, so a recorded response loads as-is.
 */
export const loadCatalogFile = (path: string): CatalogItem[] => {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    throw new Error(`rxvortex catalog not found: ${path}`)
  }
  try {
    return parseCatalog(JSON.parse(raw))
  } catch (error) {
    throw new Error(`rxvortex catalog ${path}: ${(error as Error).message}`)
  }
}

/** How `serve` (and `serve --config`) builds the RxVortex mock from flags. */
export const serveTarget: ServeTarget = {
  name: "rxvortex",
  defaultPort: DEFAULT_PORT,
  options: {
    "webhook-url": {
      type: "string",
      value: "<url>",
      description:
        "Deliver status webhooks here (e.g. http://127.0.0.1:3000/prescriptions/webhooks/rxvortex)",
    },
    "webhook-secret": {
      type: "string",
      value: "<secret>",
      description: "Sent as x-rxvortex-webhook-secret (the app's RXVORTEX_WEBHOOK_SECRET)",
    },
    "api-token": {
      type: "string",
      value: "<token>",
      description: "A static bearer token to accept (the app's RXVORTEX_API_TOKEN)",
    },
    catalog: {
      type: "string",
      value: "<file.json>",
      description:
        "Preset catalog every namespace starts with and resets to: a JSON array, or {data: [...]} as GET /api/v1/preset-catalog-items returns",
    },
    "unknown-presets": {
      type: "string",
      value: "<reject|accept>",
      description:
        "An unknown preset_catalog_id: 422 like the sandbox (reject, default) or add it (accept)",
    },
    "auto-advance": {
      type: "string",
      value: "<ms:Status,Status,…>",
      description: 'Walk every new order along a path, e.g. "2000:Fill,Shipping,Delivered"',
    },
  },
  create: (values, common) => {
    const url = text(values["webhook-url"])
    const secret = text(values["webhook-secret"])
    const token = text(values["api-token"])
    const auto = text(values["auto-advance"])
    const catalogPath = text(values.catalog)
    const unknownPresets = text(values["unknown-presets"])
    if (unknownPresets !== undefined && unknownPresets !== "reject" && unknownPresets !== "accept")
      throw new Error('--unknown-presets must be "reject" or "accept"')
    const plan = auto ? /^(\d+):(.+)$/.exec(auto) : null
    if (auto && !plan)
      throw new Error('--auto-advance must look like "2000:Fill,Shipping,Delivered"')
    return createRuntime({
      tickMs: 100,
      ...(url ? { webhooks: { url, ...(secret ? { secret } : {}) } } : {}),
      ...(catalogPath ? { catalog: loadCatalogFile(catalogPath) } : {}),
      settings: {
        ...(unknownPresets ? { unknownPresets } : {}),
        ...(token ? { staticTokens: [token] } : {}),
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
    "auth: POST /api/v1/generate-access-token {client_id, client_secret}, then Authorization: Bearer <token>",
    "namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<client_id>: <ns>}",
  ],
}
