/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type EdamamRuntime, type EdamamRuntimeOptions } from "./runtime.js"

/** Port `mockingbird-edamam serve` listens on when none is given. */
export const DEFAULT_PORT = 8824

export type EdamamServerOptions = EdamamRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type EdamamServer = Listening & { runtime: EdamamRuntime }

/** Serve the Edamam mock over `node:http`. */
export const createServer = async (options: EdamamServerOptions = {}): Promise<EdamamServer> => {
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

/** How `serve` (and `serve --config`) builds the Edamam mock from flags. */
export const serveTarget: ServeTarget = {
  name: "edamam",
  defaultPort: DEFAULT_PORT,
  options: {
    app: {
      type: "string",
      value: "<app_id:app_key>",
      description:
        "Accept only this application pair (EDAMAM_*_APP_ID:EDAMAM_*_APP_KEY); default: any",
    },
    "require-account-user": {
      type: "boolean",
      description:
        "Answer 401 to recipe / meal-planner / shopping-list calls without Edamam-Account-User",
    },
  },
  create: (values, common) => {
    const app = text(values.app)
    const colon = app?.indexOf(":") ?? -1
    if (app && colon < 1) throw new Error('--app must look like "app_id:app_key"')
    return createRuntime({
      settings: {
        ...(app ? { apps: [{ appId: app.slice(0, colon), appKey: app.slice(colon + 1) }] } : {}),
        ...(values["require-account-user"] === true ? { requireAccountUser: true } : {}),
      },
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "auth: ?app_id=&app_key= (plus Basic app_id:app_key on the meal planner and shopping list)",
    "namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<app_id>: <ns>}",
  ],
}
