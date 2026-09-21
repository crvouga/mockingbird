/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { type CareTalkRuntime, type CareTalkRuntimeOptions, createRuntime } from "./runtime.js"

/** Port `mockingbird-caretalk serve` listens on when none is given. */
export const DEFAULT_PORT = 8823

export type CareTalkServerOptions = CareTalkRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type CareTalkServer = Listening & { runtime: CareTalkRuntime }

/** Serve the CareTalk mock over `node:http`. */
export const createServer = async (
  options: CareTalkServerOptions = {},
): Promise<CareTalkServer> => {
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

/** How `serve` (and `serve --config`) builds the CareTalk mock from flags. */
export const serveTarget: ServeTarget = {
  name: "caretalk",
  defaultPort: DEFAULT_PORT,
  options: {
    "api-user": {
      type: "string",
      value: "<userName:password>",
      description:
        "Accept only this client-login pair (CARETALK_USERNAME:CARETALK_PASSWORD); default: any",
    },
    "api-key": {
      type: "string",
      value: "<key>",
      description: "Accept only this static bearer key (CARETALK_API_KEY); default: any",
    },
  },
  create: (values, common) => {
    const user = text(values["api-user"])
    const key = text(values["api-key"])
    const colon = user?.indexOf(":") ?? -1
    if (user && colon < 1) throw new Error('--api-user must look like "userName:password"')
    return createRuntime({
      settings: {
        ...(user
          ? { users: [{ userName: user.slice(0, colon), password: user.slice(colon + 1) }] }
          : {}),
        ...(key ? { apiKeys: [key] } : {}),
      },
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "auth: POST /externalapi/Auth/client-login {userName, password}, then Authorization: Bearer <token>",
    "namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<userName>: <ns>}",
  ],
}
