/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type TwilioRuntime, type TwilioRuntimeOptions } from "./runtime.js"

/** Port `mockingbird-twilio serve` listens on when none is given. */
export const DEFAULT_PORT = 8798

export type TwilioServerOptions = TwilioRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type TwilioServer = Listening & { runtime: TwilioRuntime }

/** Serve the Twilio mock over `node:http`. */
export const createServer = async (options: TwilioServerOptions = {}): Promise<TwilioServer> => {
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

/** How `serve` (and `serve --config`) builds the Twilio mock from flags. */
export const serveTarget: ServeTarget = {
  name: "twilio",
  defaultPort: DEFAULT_PORT,
  options: {
    "app-url": {
      type: "string",
      value: "<url>",
      description:
        "Post inbound SMS and voice webhooks to this app origin (e.g. http://127.0.0.1:3000)",
    },
    "public-base-url": {
      type: "string",
      value: "<url>",
      description: "Sign webhooks against this base (the app's TWILIO_VOICE_WEBHOOK_BASE_URL)",
    },
    "account-sid": {
      type: "string",
      value: "<AC…>",
      description: "The app's TWILIO_ACCOUNT_SID (AccountSid in webhooks)",
    },
    "auth-token": {
      type: "string",
      value: "<token>",
      description:
        "The app's TWILIO_AUTH_TOKEN: signs webhooks, and with --account-sid is the only accepted token",
    },
    "caller-id": {
      type: "string",
      value: "<+1…>",
      description: "To of inbound SMS (the app's TWILIO_VOICE_CALLER_ID)",
    },
    "fixed-code": {
      type: "string",
      value: "<digits>",
      description: "Every Verify code is this (default: random 6 digits, read via /__admin)",
    },
  },
  create: (values, common) => {
    const appUrl = text(values["app-url"])
    const accountSid = text(values["account-sid"])
    const authToken = text(values["auth-token"])
    const publicBaseUrl = text(values["public-base-url"])
    const callerId = text(values["caller-id"])
    const fixedCode = text(values["fixed-code"])
    if (appUrl && !authToken) throw new Error("--app-url needs --auth-token (the signing key)")
    return createRuntime({
      ...(appUrl && authToken
        ? {
            app: {
              url: appUrl,
              authToken,
              ...(publicBaseUrl ? { publicBaseUrl } : {}),
              ...(accountSid ? { accountSid } : {}),
              ...(callerId ? { callerId } : {}),
            },
          }
        : {}),
      ...(accountSid && authToken ? { accounts: { [accountSid]: authToken } } : {}),
      ...(fixedCode ? { verify: { fixedCode } } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "routes: /lookups/v2/…, /verify/v2/…, /api/2010-04-01/… (the Twilio host as a path prefix)",
    "auth: Basic AccountSid:AuthToken; OTP: GET /__admin/verify/<e164>/latest",
    "namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<AccountSid>: <ns>}",
  ],
}
