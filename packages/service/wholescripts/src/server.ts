/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
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
  },
  create: (values, common) => {
    const username = text(values.username)
    const password = text(values.password)
    const auto = text(values["auto-advance"])
    const plan = auto ? /^(\d+):(.+)$/.exec(auto) : null
    if (auto && !plan) throw new Error('--auto-advance must look like "2000:Processing,Complete"')
    return createRuntime({
      tickMs: 100,
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
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "auth: Authorization: Basic <WHOLESCRIPTS_USERNAME:WHOLESCRIPTS_PASSWORD> (any pair unless --username/--password)",
    "namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<username>: <ns>}",
  ],
}
