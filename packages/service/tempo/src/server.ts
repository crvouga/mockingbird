/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type TempoRuntime, type TempoRuntimeOptions } from "./runtime.js"

/** Port `mockingbird-tempo serve` listens on when none is given. */
export const DEFAULT_PORT = 8930

export type TempoServerOptions = TempoRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type TempoServer = Listening & { runtime: TempoRuntime }

/** Serve the Tempo mock over `node:http`: one origin for the OTLP receiver and the query API. */
export const createServer = async (options: TempoServerOptions = {}): Promise<TempoServer> => {
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

/** How `serve` (and `serve --config`) builds the Tempo mock from flags. */
export const serveTarget: ServeTarget = {
  name: "tempo",
  defaultPort: DEFAULT_PORT,
  options: {
    "bearer-token": {
      type: "string",
      value: "<token>",
      description: "Only accept this bearer token on ingest and query; default no authentication",
    },
    "basic-auth": {
      type: "string",
      value: "<user:password>",
      description:
        "Only accept these Basic credentials (Grafana Cloud: instance id and access token)",
    },
    multitenancy: {
      type: "boolean",
      description:
        "Require X-Scope-OrgID and isolate tenants, like multitenancy_enabled: true; default off",
    },
    "left-pad-trace-ids": {
      type: "boolean",
      description:
        "Search answers 32-character trace ids, like left_pad_trace_ids; default trimmed",
    },
  },
  create: (values, common) => {
    const token = text(values["bearer-token"])
    const auth = text(values["basic-auth"])
    const colon = auth?.indexOf(":") ?? -1
    return createRuntime({
      settings: {
        ...(token ? { bearerTokens: [token] } : {}),
        ...(auth
          ? {
              basicUsers: [
                colon < 0
                  ? { username: auth, password: "" }
                  : { username: auth.slice(0, colon), password: auth.slice(colon + 1) },
              ],
            }
          : {}),
        ...(values.multitenancy === true ? { multitenancy: true } : {}),
        ...(values["left-pad-trace-ids"] === true ? { leftPadTraceIds: true } : {}),
      },
      ...(common.adminPrefix !== undefined ? { adminPrefix: common.adminPrefix } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.adminControls !== undefined ? { adminControls: common.adminControls } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "otlp: OTEL_EXPORTER_OTLP_ENDPOINT=<this> (POST /v1/traces, JSON or protobuf)",
    "query: <this>/api/search?q=…, /api/traces/<id>, /api/v2/search/tags?scope=span",
    "admin: GET /__admin/traces, POST /__admin/traces {resourceSpans}, PUT /__admin/settings",
  ],
}
