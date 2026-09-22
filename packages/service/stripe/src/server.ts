/// <reference types="node" />
import { readFileSync } from "node:fs"
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { validateAccounts } from "./accounts.js"
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
  typeof value === "string" && value !== "" ? value : undefined

/** `--accounts` takes inline JSON or a path to a JSON file. */
const readAccounts = (value: string) => {
  const raw =
    value.trim().startsWith("[") || value.trim().startsWith("{")
      ? value
      : readFileSync(value, "utf8")
  const parsed = validateAccounts(JSON.parse(raw))
  if (typeof parsed === "string") throw new Error(`--accounts: ${parsed}`)
  return parsed
}

/** How `serve` (and `serve --config`) builds the Stripe mock from flags. */
export const serveTarget: ServeTarget = {
  name: "stripe",
  defaultPort: DEFAULT_PORT,
  options: {
    accounts: {
      type: "string",
      value: "<json|file>",
      description:
        'Accounts and their keys, e.g. [{"id":"acct_mso","keys":["sk_test_…"],"webhookSecrets":{"http://…/billing/webhooks/stripe/mso":"whsec_…"},"corpus":true}]',
    },
    "webhook-url": {
      type: "string",
      value: "<url>",
      description: "Deliver every account's events here (signed with --webhook-secret)",
    },
    "webhook-secret": {
      type: "string",
      value: "<whsec_…>",
      description: "Secret for --webhook-url's Stripe-Signature",
    },
    "public-url": {
      type: "string",
      value: "<url>",
      description: "Base URL of the hosted Checkout page and Stripe.js when behind a proxy",
    },
  },
  create: (values, common) => {
    const url = text(values["webhook-url"])
    const secret = text(values["webhook-secret"])
    const accounts = text(values.accounts)
    const publicUrl = text(values["public-url"])
    return createRuntime({
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
      ...(accounts ? { accounts: readAccounts(accounts) } : {}),
      ...(url ? { webhooks: { endpoints: [{ url, ...(secret ? { secret } : {}) }] } } : {}),
      ...(publicUrl ? { publicUrl } : {}),
      tickMs: 1000,
    })
  },
  banner: () => [
    "auth: Authorization: Bearer sk_test_<anything>; unconfigured keys are accounts of their own",
    'stripe-node: new Stripe(key, { host: "127.0.0.1", port: <port>, protocol: "http" })',
    "accounts: PUT /__admin/accounts; webhooks: PUT /__admin/webhook-endpoints",
    "hosted Checkout: session.url → /c/pay/<id>; Stripe.js stand-in: /v3",
  ],
}
