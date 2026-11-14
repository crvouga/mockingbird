/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type ShopifyRuntime, type ShopifyRuntimeOptions } from "./runtime.js"

/** Port `mockingbird-shopify serve` listens on when none is given. */
export const DEFAULT_PORT = 12159

export type ShopifyServerOptions = ShopifyRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type ShopifyServer = Listening & { runtime: ShopifyRuntime }

/** Serve the Shopify Admin GraphQL emulator over `node:http`. */
export const createServer = async (options: ShopifyServerOptions = {}): Promise<ShopifyServer> => {
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

/** How `serve` (and `serve --config`) builds the Shopify emulator from flags. */
export const serveTarget: ServeTarget = {
  name: "shopify",
  defaultPort: DEFAULT_PORT,
  options: {
    "access-token": {
      type: "string",
      value: "<token>",
      description: "The only X-Shopify-Access-Token to accept (default: any non-empty token)",
    },
    "api-secret": {
      type: "string",
      value: "<secret>",
      description: "The app's client secret: the X-Shopify-Hmac-Sha256 key for webhooks",
    },
    "shop-domain": {
      type: "string",
      value: "<shop>.myshopify.com",
      description: "Sent as X-Shopify-Shop-Domain and returned by shop { myshopifyDomain }",
    },
  },
  create: (values, common) => {
    const token = text(values["access-token"])
    const secret = text(values["api-secret"])
    const domain = text(values["shop-domain"])
    return createRuntime({
      settings: {
        ...(token ? { accessTokens: [token] } : {}),
        ...(secret ? { apiSecret: secret } : {}),
        ...(domain ? { shopDomain: domain } : {}),
      },
      ...(common.adminPrefix !== undefined ? { adminPrefix: common.adminPrefix } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.adminControls !== undefined ? { adminControls: common.adminControls } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "GraphQL: POST /admin/api/<version>/graphql.json with X-Shopify-Access-Token",
    "webhooks: webhookSubscriptionCreate, signed with X-Shopify-Hmac-Sha256 (--api-secret)",
    "namespaces: x-mockingbird-namespace, /__admin/ns/<name>/admin/api/…, or PUT /__admin/credentials {<token>: <ns>}",
  ],
}
