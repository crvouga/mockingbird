/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type GoogleMapsRuntime, type GoogleMapsRuntimeOptions } from "./runtime.js"

/** Port `mockingbird-google-maps serve` listens on when none is given. */
export const DEFAULT_PORT = 8814

export type GoogleMapsServerOptions = GoogleMapsRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type GoogleMapsServer = Listening & { runtime: GoogleMapsRuntime }

/** Serve the Google Maps mock over `node:http`. */
export const createServer = async (
  options: GoogleMapsServerOptions = {},
): Promise<GoogleMapsServer> => {
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

/** How `serve` (and `serve --config`) builds the Google Maps mock from flags. */
export const serveTarget: ServeTarget = {
  name: "google-maps",
  defaultPort: DEFAULT_PORT,
  options: {
    "api-key": {
      type: "string",
      value: "<key[,key…]>",
      description: "Accept only these API keys (the app's PLACES_KEY); default: any non-empty key",
    },
    "public-url": {
      type: "string",
      value: "<url>",
      description:
        "Origin the Maps JavaScript shim calls back to, when it differs from the request's",
    },
  },
  create: (values, common) => {
    const keys = text(values["api-key"])
    const publicUrl = text(values["public-url"])
    return createRuntime({
      settings: {
        ...(keys
          ? {
              keys: keys
                .split(",")
                .map((k) => k.trim())
                .filter(Boolean),
            }
          : {}),
        ...(publicUrl ? { publicUrl } : {}),
      },
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "REST: /maps/api/place/{autocomplete,details,findplacefromtext}/json, /maps/api/geocode/json (?key=)",
    'web: <script src="<this server>/maps/api/js?key=…&libraries=places">',
    "Address Validation: POST /v1:validateAddress?key= (addressvalidation.googleapis.com)",
    "namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<key>: <ns>}",
  ],
}
