/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import {
  createRuntime,
  type GoogleCalendarRuntime,
  type GoogleCalendarRuntimeOptions,
} from "./runtime.js"

/** Port `mockingbird-google-calendar serve` listens on when none is given. */
export const DEFAULT_PORT = 8820

export type GoogleCalendarServerOptions = GoogleCalendarRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type GoogleCalendarServer = Listening & { runtime: GoogleCalendarRuntime }

/** Serve the Google Calendar mock over `node:http`. */
export const createServer = async (
  options: GoogleCalendarServerOptions = {},
): Promise<GoogleCalendarServer> => {
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

/** How `serve` (and `serve --config`) builds the GoogleCalendar mock from flags. */
export const serveTarget: ServeTarget = {
  name: "google-calendar",
  defaultPort: DEFAULT_PORT,
  options: {
    client: {
      type: "string",
      value: "<client_id:client_secret>",
      description:
        "Accept only this OAuth client (GOOGLE_CLIENT_ID:GOOGLE_CLIENT_SECRET); default: any",
    },
    "require-https-webhooks": {
      type: "boolean",
      description:
        "Reject non-https watch addresses, as Google does (default: allow http for local receivers)",
    },
  },
  create: (values, common) => {
    const client = text(values.client)
    const colon = client?.indexOf(":") ?? -1
    if (client && colon < 1) throw new Error('--client must look like "client_id:client_secret"')
    return createRuntime({
      settings: {
        ...(client
          ? {
              clients: [
                { clientId: client.slice(0, colon), clientSecret: client.slice(colon + 1) },
              ],
            }
          : {}),
        ...(values["require-https-webhooks"] === true ? { requireHttpsWebhooks: true } : {}),
      },
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "rootUrl: <this url>/ for googleapis; OAuth2Client endpoints: <this url>/token, <this url>/revoke",
    "sign in with authorization code 4/mock-<name> (→ <name>@example.com) or 4/mock-<email>",
    "namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<email>: <ns>}",
  ],
}
