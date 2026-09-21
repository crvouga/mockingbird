/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type StripeRuntime, type StripeRuntimeOptions } from "./runtime.js"

/** Port `mockingbird-stripe serve` listens on when none is given. */
export const DEFAULT_PORT = 12111

export type StripeServerOptions = StripeRuntimeOptions & {
  /** Default `0`: the OS picks a free port (read it from `url` / `port`). */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type StripeServer = Listening & { runtime: StripeRuntime }

/** Serve the Stripe mock over `node:http`. Resolves once it is listening. */
export const createServer = async (options: StripeServerOptions = {}): Promise<StripeServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, {
    port: port ?? 0,
    ...(host !== undefined ? { host } : {}),
  })
  return { ...listening, runtime }
}

/** How `serve` (and `serve --config`) builds the Stripe mock from flags. */
export const serveTarget: ServeTarget = {
  name: "stripe",
  defaultPort: DEFAULT_PORT,
  create: (_values, common) =>
    createRuntime({
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }),
  banner: () => [
    "auth: Authorization: Bearer sk_test_<anything>; each key is its own account",
    'stripe-node: new Stripe(key, { host: "127.0.0.1", port: <port>, protocol: "http" })',
  ],
}
