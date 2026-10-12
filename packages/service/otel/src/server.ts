/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type OtelRuntime, type OtelRuntimeOptions } from "./runtime.js"
import { INGEST_AUTH_MODES, type IngestAuth } from "./state.js"

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

/** `user:password` as the flags take it (a bare `user` has an empty password). */
const credentials = (auth: string) => {
  const colon = auth.indexOf(":")
  return colon < 0
    ? { username: auth, password: "" }
    : { username: auth.slice(0, colon), password: auth.slice(colon + 1) }
}

const csv = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")

/** How `serve` (and `serve --config`) builds the OTel mock from flags. */
export const serveTarget: ServeTarget = {
  name: "otel",
  defaultPort: DEFAULT_PORT,
  options: {
    "ingest-auth": {
      type: "string",
      value: "<bearer|basic|none>",
      description:
        "What the OTLP receiver asks of an export: a bearer token, Basic credentials, or nothing (an unauthenticated collector); default bearer",
    },
    "ingest-token": {
      type: "string",
      value: "<token>",
      description: "Only accept this OTLP bearer token (the app's OTEL_AUTH_TOKEN); default any",
    },
    "ingest-basic-auth": {
      type: "string",
      value: "<user:password>",
      description:
        "Only accept these OTLP Basic credentials (a hosted gateway's instanceId:token); implies --ingest-auth basic",
    },
    "cors-origins": {
      type: "string",
      value: "<origin,…>",
      description:
        "Origins a browser exporter may send from (https://app.example, https://*.example, or *); default no CORS",
    },
    "cors-headers": {
      type: "string",
      value: "<header,…>",
      description:
        "Request headers a preflight may name (or *); default accept, content-type, x-requested-with",
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
    const ingestBasic = text(values["ingest-basic-auth"])
    const ingestAuth = text(values["ingest-auth"]) ?? (ingestBasic ? "basic" : "bearer")
    if (!INGEST_AUTH_MODES.includes(ingestAuth as IngestAuth)) {
      throw new Error(`--ingest-auth must be one of ${INGEST_AUTH_MODES.join(", ")}`)
    }
    const origins = csv(text(values["cors-origins"]))
    const headers = csv(text(values["cors-headers"]))
    return createRuntime({
      settings: {
        ingestAuth: ingestAuth as IngestAuth,
        ...(token ? { ingestTokens: [token] } : {}),
        ...(ingestBasic ? { ingestUsers: [credentials(ingestBasic)] } : {}),
        ...(origins.length > 0
          ? {
              cors: {
                allowedOrigins: origins,
                ...(headers.length > 0 ? { allowedHeaders: headers } : {}),
              },
            }
          : {}),
        ...(auth ? { searchUsers: [credentials(auth)] } : {}),
        ...(values["keep-bodies"] === true ? { keepBodies: true } : {}),
      },
      ...(common.adminPrefix !== undefined ? { adminPrefix: common.adminPrefix } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.adminControls !== undefined ? { adminControls: common.adminControls } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "otlp: OTEL_EXPORTER_OTLP_ENDPOINT=<this> (POST /v1/traces, /v1/logs, /v1/metrics; JSON or protobuf), Authorization: Bearer <OTEL_AUTH_TOKEN> (--ingest-auth basic|none for a Basic or unauthenticated collector)",
    "o2: O2_BASE_URL=<this>, Basic O2_BASIC_AUTH; orgs development=30rBqcDevOrg7Hn2KmQ4xW9sLtY production=3HSzeProdOrg5Jd8VpN1cR6gTfB",
    "admin: GET /__admin/logs?event=…, POST /__admin/wait {kind, where, count, timeoutMs}",
  ],
}
