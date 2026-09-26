/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type VpiRuntime, type VpiRuntimeOptions } from "./runtime.js"

/** Port `mockingbird-vpi serve` listens on when none is given. */
export const DEFAULT_PORT = 8802

export type VpiServerOptions = VpiRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type VpiServer = Listening & { runtime: VpiRuntime }

/** Serve the VPI mock over `node:http`. */
export const createServer = async (options: VpiServerOptions = {}): Promise<VpiServer> => {
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

/** How `serve` (and `serve --config`) builds the VPI mock from flags. */
export const serveTarget: ServeTarget = {
  name: "vpi",
  defaultPort: DEFAULT_PORT,
  options: {
    "token-ttl": {
      type: "string",
      value: "<seconds>",
      description:
        "JWT lifetime on the mock clock (default 3600; our client caches until exp - 30 s)",
    },
  },
  create: (values, common) => {
    const ttl = text(values["token-ttl"])
    if (ttl !== undefined && !(Number(ttl) > 0)) throw new Error("--token-ttl must be seconds > 0")
    return createRuntime({
      ...(ttl !== undefined ? { settings: { tokenTtlSeconds: Number(ttl) } } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "auth: POST /accounts/authenticate {email, password, isPatientLogin: false}, then Authorization: Bearer <jwtToken>",
    "namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<VPI_API_EMAIL>: <ns>}",
    "the app's VPI_API_URL defaults to PRODUCTION (https://api.vpicompounding.net): set it to this mock",
  ],
}
