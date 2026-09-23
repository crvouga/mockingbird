/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type OtelRuntime, type OtelRuntimeOptions } from "./runtime.js"

/** Port `mockingbird-otel serve` listens on when none is given. */
export const DEFAULT_PORT = 8809

export type OtelServerOptions = OtelRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type OtelServer = Listening & { runtime: OtelRuntime }

/** Serve the OTLP collector + O2 search mock over `node:http`. */
export const createServer = async (options: OtelServerOptions = {}): Promise<OtelServer> => {
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

/** How `serve` (and `serve --config`) builds the OTel mock from flags. */
export const serveTarget: ServeTarget = {
  name: "otel",
  defaultPort: DEFAULT_PORT,
  options: {
    "ingest-token": {
      type: "string",
      value: "<token>",
      description: "Only accept this OTLP bearer token (the app's OTEL_AUTH_TOKEN); default any",
    },
    "search-auth": {
      type: "string",
      value: "<user:password>",
      description: "Only accept these O2 Basic credentials (decoded O2_BASIC_AUTH); default any",
    },
    "keep-bodies": {
      type: "boolean",
      description:
        "Store log bodies (local debugging only: bodies can hold prompts or PHI); default drop",
    },
  },
  create: (values, common) => {
    const token = text(values["ingest-token"])
    const auth = text(values["search-auth"])
    const colon = auth?.indexOf(":") ?? -1
    return createRuntime({
      settings: {
        ...(token ? { ingestTokens: [token] } : {}),
        ...(auth
          ? {
              searchUsers: [
                colon < 0
                  ? { username: auth, password: "" }
                  : { username: auth.slice(0, colon), password: auth.slice(colon + 1) },
              ],
            }
          : {}),
        ...(values["keep-bodies"] === true ? { keepBodies: true } : {}),
      },
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "otlp: OTEL_EXPORTER_OTLP_ENDPOINT=<this> (POST /v1/traces, /v1/logs, /v1/metrics; JSON or protobuf), Authorization: Bearer <OTEL_AUTH_TOKEN>",
    "o2: O2_BASE_URL=<this>, Basic O2_BASIC_AUTH; orgs development=30rBqcDevOrg7Hn2KmQ4xW9sLtY production=3HSzeProdOrg5Jd8VpN1cR6gTfB",
    "admin: GET /__admin/logs?event=…, POST /__admin/wait {kind, where, count, timeoutMs}",
  ],
}
