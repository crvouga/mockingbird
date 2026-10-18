/// <reference types="node" />
import { readFileSync } from "node:fs"
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { type Catalog, DEFAULT_CATALOG, mergeCatalog, parseCatalogDocument } from "./catalog.js"
import {
  createRuntime,
  type WholescriptsRuntime,
  type WholescriptsRuntimeOptions,
} from "./runtime.js"

/** Port `mockingbird-wholescripts serve` listens on when none is given. */
export const DEFAULT_PORT = 8803

export type WholescriptsServerOptions = WholescriptsRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type WholescriptsServer = Listening & { runtime: WholescriptsRuntime }

/** Serve the Wholescripts mock over `node:http`, with auto-advance ticking every 100 ms. */
export const createServer = async (
  options: WholescriptsServerOptions = {},
): Promise<WholescriptsServer> => {
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
 * Read a catalog file (`{products?, medPaxPills?, privateLabelCartons?}`, or a bare array of
 * products) and lay it onto {@link DEFAULT_CATALOG} (`merge`, the default: a SKU the default has
 * is replaced in place, any other is added) or use it as the whole catalog (`replace`: a list the
 * file leaves out is empty).
 */
export const loadCatalogFile = (path: string, mode: "merge" | "replace" = "merge"): Catalog => {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    throw new Error(`wholescripts catalog not found: ${path}`)
  }
  try {
    const parsed = parseCatalogDocument(JSON.parse(raw))
    return mode === "replace"
      ? { products: [], medPaxPills: [], privateLabelCartons: [], ...parsed }
      : mergeCatalog(DEFAULT_CATALOG, parsed)
  } catch (error) {
    throw new Error(`wholescripts catalog ${path}: ${(error as Error).message}`)
  }
}

/** How `serve` (and `serve --config`) builds the Wholescripts mock from flags. */
export const serveTarget: ServeTarget = {
  name: "wholescripts",
  defaultPort: DEFAULT_PORT,
  options: {
    username: {
      type: "string",
      value: "<user>",
      description: "Accept only this Basic username (the app's WHOLESCRIPTS_USERNAME)",
    },
    password: {
      type: "string",
      value: "<password>",
      description: "Accept only this Basic password (the app's WHOLESCRIPTS_PASSWORD)",
    },
    "auto-advance": {
      type: "string",
      value: "<ms:Status,Status,…>",
      description: 'Walk every new order along a path, e.g. "2000:Processing,Complete"',
    },
    catalog: {
      type: "string",
      value: "<file.json>",
      description:
        "Catalog rows every namespace starts with and resets to: {products?, medPaxPills?, privateLabelCartons?} or a bare array of products, merged onto the default catalog by SKU",
    },
    "catalog-mode": {
      type: "string",
      value: "<merge|replace>",
      description:
        "With --catalog: merge onto the default catalog (default) or use the file as the whole catalog",
    },
  },
  create: (values, common) => {
    const username = text(values.username)
    const password = text(values.password)
    const auto = text(values["auto-advance"])
    const plan = auto ? /^(\d+):(.+)$/.exec(auto) : null
    if (auto && !plan) throw new Error('--auto-advance must look like "2000:Processing,Complete"')
    const catalogPath = text(values.catalog)
    const mode = text(values["catalog-mode"])
    if (mode !== undefined && mode !== "merge" && mode !== "replace")
      throw new Error('--catalog-mode must be "merge" or "replace"')
    if (mode !== undefined && catalogPath === undefined)
      throw new Error("--catalog-mode needs --catalog")
    return createRuntime({
      tickMs: 100,
      ...(catalogPath ? { catalog: loadCatalogFile(catalogPath, mode) } : {}),
      settings: {
        ...(username && password ? { accounts: [{ username, password }] } : {}),
        ...(plan
          ? {
              autoAdvance: {
                afterMs: Number(plan[1]),
                path: (plan[2] as string).split(",").map((s) => s.trim()),
              },
            }
          : {}),
      },
      ...(common.adminPrefix !== undefined ? { adminPrefix: common.adminPrefix } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.adminControls !== undefined ? { adminControls: common.adminControls } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "auth: Authorization: Basic <WHOLESCRIPTS_USERNAME:WHOLESCRIPTS_PASSWORD> (any pair unless --username/--password)",
    "namespaces: x-mockingbird-namespace, /__admin/ns/<name>/…, or PUT /__admin/credentials {<username>: <ns>}",
  ],
}
