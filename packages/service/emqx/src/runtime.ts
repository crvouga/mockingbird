import {
  brokerAdminRoutes,
  type Connection,
  connackPreset,
  connectNamespace,
  MQTT_CONNECT_OPERATION,
  MQTT_WEBSOCKET_PATH,
  observeClock,
  ReasonCode,
  routeConnection,
  type Transport,
  type TransportInfo,
  takeConnackFault,
  webSocketNamespace,
} from "@crvouga/mockingbird-mqtt-broker"
import {
  type AdminRoutes,
  type Clock,
  createClock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  type MockControls,
  type RequestLog,
  resolveAdminPrefix,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import { apiKeyCredential, EMQX_NAMESPACE, EmqxAPI } from "./index.js"
import type { SettingsPatch } from "./state.js"

export { MQTT_CONNECT_OPERATION, MQTT_WEBSOCKET_PATH }

/**
 * Every named EMQX failure a consumer branches on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it).
 */
export const EMQX_PRESETS: Record<string, FaultPreset> = {
  connect_bad_credentials: connackPreset(
    ReasonCode.BadUserNameOrPassword,
    "MQTT CONNECT is refused with CONNACK 0x86 Bad User Name or Password",
  ),
  connect_not_authorized: connackPreset(
    ReasonCode.NotAuthorized,
    "MQTT CONNECT is refused with CONNACK 0x87 Not authorized",
  ),
  connect_server_unavailable: connackPreset(
    ReasonCode.ServerUnavailable,
    "MQTT CONNECT is refused with CONNACK 0x88 Server unavailable",
  ),
  publish_unavailable: {
    description: "POST /api/v5/publish answers 503 failed_to_dispatch and delivers nothing",
    rules: [
      {
        operationId: "PublishMessage",
        status: 503,
        body: { reason_code: 131, message: "failed_to_dispatch" },
      },
    ],
  },
  api_unauthorized: {
    description: "Every REST call answers 401 BAD_API_KEY_OR_SECRET",
    rules: [
      {
        pathPrefix: "/api/v5",
        status: 401,
        body: { code: "BAD_API_KEY_OR_SECRET", message: "Check api_key/api_secret" },
        headers: { "www-authenticate": 'Basic Realm="emqx-dashboard"' },
      },
    ],
  },
}

export type EmqxRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
  /** API keys, MQTT users and the JWT authenticator every namespace starts with and resets to. */
  settings?: SettingsPatch
}

export type EmqxRuntime = ServiceRuntime<EmqxAPI> & {
  /**
   * Attach an MQTT client transport. The namespace is `namespace` when given; otherwise the
   * one `PUT /__admin/credentials` maps the CONNECT's username, then its client identifier, to;
   * otherwise the default one.
   */
  attach(transport: Transport, info?: TransportInfo, namespace?: string): Connection
  /**
   * Whether an HTTP path is the MQTT WebSocket endpoint: `/mqtt`, or
   * `/__admin/ns/<name>/mqtt` to select a namespace. `undefined` when it is neither.
   */
  webSocketPath(pathname: string): { namespace: string | undefined } | undefined
  /** Listener URLs a server registers, reported by `GET /__admin/health`. */
  readonly endpoints: { mqtt?: string; websocket?: string }
  /** Drop every MQTT connection. Sessions stay under their own expiry. */
  stop(): void
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseSettings = (body: unknown): SettingsPatch | string => {
  if (!isRecord(body)) return "expected a JSON object"
  const patch: SettingsPatch = {}
  const pairs = (value: unknown, first: string, second: string) =>
    Array.isArray(value) &&
    value.every(
      (each) =>
        isRecord(each) && typeof each[first] === "string" && typeof each[second] === "string",
    )
  if (body.apiKeys !== undefined) {
    if (!pairs(body.apiKeys, "key", "secret")) return "apiKeys: [{key, secret}]"
    patch.apiKeys = (body.apiKeys as Record<string, string>[]).map((each) => ({
      key: each.key as string,
      secret: each.secret as string,
    }))
  }
  if (body.users !== undefined) {
    if (!pairs(body.users, "username", "password")) {
      return "users: [{username, password, superuser?}]"
    }
    patch.users = (body.users as Record<string, unknown>[]).map((each) => ({
      username: each.username as string,
      password: each.password as string,
      ...(each.superuser === true ? { superuser: true } : {}),
    }))
  }
  if (body.jwt !== undefined) {
    if (body.jwt === null) patch.jwt = null
    else {
      const jwt = body.jwt
      if (!isRecord(jwt) || typeof jwt.secret !== "string") return "jwt: {secret, …} or null"
      if (jwt.from !== undefined && jwt.from !== "password" && jwt.from !== "username") {
        return 'jwt.from: "password" | "username"'
      }
      if (
        jwt.verifyClaims !== undefined &&
        !(
          isRecord(jwt.verifyClaims) &&
          Object.values(jwt.verifyClaims).every((v) => typeof v === "string")
        )
      ) {
        return "jwt.verifyClaims: {<claim>: <expected>}"
      }
      patch.jwt = {
        secret: jwt.secret,
        ...(typeof jwt.secretBase64Encoded === "boolean"
          ? { secretBase64Encoded: jwt.secretBase64Encoded }
          : {}),
        ...(jwt.from !== undefined ? { from: jwt.from } : {}),
        ...(typeof jwt.aclClaimName === "string" ? { aclClaimName: jwt.aclClaimName } : {}),
        ...(jwt.verifyClaims !== undefined
          ? { verifyClaims: jwt.verifyClaims as Record<string, string> }
          : {}),
        ...(typeof jwt.disconnectAfterExpire === "boolean"
          ? { disconnectAfterExpire: jwt.disconnectAfterExpire }
          : {}),
      }
    }
  }
  if (body.authorization !== undefined) {
    const authorization = body.authorization
    if (!isRecord(authorization)) return "authorization: {noMatch?, denyAction?}"
    const { noMatch, denyAction } = authorization
    if (noMatch !== undefined && noMatch !== "allow" && noMatch !== "deny") {
      return 'authorization.noMatch: "allow" | "deny"'
    }
    if (denyAction !== undefined && denyAction !== "ignore" && denyAction !== "disconnect") {
      return 'authorization.denyAction: "ignore" | "disconnect"'
    }
    patch.authorization = {
      ...(noMatch !== undefined ? { noMatch } : {}),
      ...(denyAction !== undefined ? { denyAction } : {}),
    }
  }
  return patch
}

const adminRoutes = (runtime: ServiceRuntime<EmqxAPI>): AdminRoutes => ({
  ...brokerAdminRoutes((namespace) => runtime.instance(namespace).broker),
  "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
  "PUT /settings": ({ body, namespace }) => {
    const patch = parseSettings(body)
    if (typeof patch === "string") return adminError(400, patch)
    return json(200, runtime.instance(namespace).state.update(patch))
  },
})

/**
 * The EMQX emulator with Mockingbird's full service contract: `/__admin/health`, `/__admin/*`,
 * namespaces by header, by `/__admin/ns/<name>` path prefix, or by API key
 * (`PUT /__admin/credentials {"credentials": {"<api key>": "<namespace>"}}`), clock control,
 * fault presets and a request journal. MQTT clients reach it through `attach`.
 */
export const createRuntime = (options: EmqxRuntimeOptions = {}): EmqxRuntime => {
  const adminPrefix = resolveAdminPrefix(options.adminPrefix)
  const endpoints: EmqxRuntime["endpoints"] = {}
  // Boot controls can move the clock while the runtime is still being built.
  let built: ServiceRuntime<EmqxAPI> | undefined
  const each = (visit: (api: EmqxAPI) => void) => {
    if (!built) return
    for (const name of built.namespaces()) visit(built.instance(name))
  }
  const runtime: ServiceRuntime<EmqxAPI> = createServiceRuntime<EmqxAPI>({
    name: EMQX_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    clock: observeClock(options.clock ?? createClock(), () => each((api) => api.broker.sweep())),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix !== undefined ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    // A namespace's own clock moving expires that namespace's sessions and messages at once.
    onClockChange: (namespace) => {
      if (built?.namespaces().includes(namespace)) built.instance(namespace).broker.sweep()
    },
    credential: apiKeyCredential,
    presets: EMQX_PRESETS,
    create: ({ sqlite, namespace, publicNamespace, clock }) =>
      new EmqxAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.settings ? { settings: options.settings } : {}),
        connectFault: () => takeConnackFault(runtime.faults, publicNamespace),
      }),
    // A restored checkpoint describes sessions, not sockets: the live ones cannot survive it.
    beforeRestore: (api) => api.broker.dropConnections(),
    describe: () => ({ ...endpoints }),
    admin: adminRoutes,
  })
  built = runtime
  return Object.assign(runtime, {
    endpoints,
    attach: (transport: Transport, info: TransportInfo = { kind: "memory" }, namespace?: string) =>
      namespace !== undefined
        ? runtime.instance(namespace).broker.connect(transport, info)
        : routeConnection(
            transport,
            (connect) => runtime.instance(connectNamespace(runtime.credentials, connect)).broker,
            info,
          ),
    webSocketPath: (pathname: string) => webSocketNamespace(pathname, adminPrefix),
    stop: () => each((api) => api.broker.dropConnections()),
  })
}
