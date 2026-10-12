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
  type FaultRule,
  type MockControls,
  type RequestLog,
  resolveAdminPrefix,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import {
  AWS_IOT_NAMESPACE,
  AwsIotAPI,
  accessKeyCredential,
  type CustomAuthorizer,
  splitUsername,
} from "./index.js"
import { parseSettings, type SettingsPatch } from "./state.js"

export { MQTT_CONNECT_OPERATION, MQTT_WEBSOCKET_PATH }

/** A canned `Publish` failure in AWS IoT's error shape. */
const publishFault = (status: number, type: string, message: string): Omit<FaultRule, "id"> => ({
  operationId: "Publish",
  status,
  body: { message, traceId: "00000000-0000-4000-8000-00000000fa17" },
  headers: { "x-amzn-errortype": type },
})

/**
 * Every named AWS IoT failure a consumer branches on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it).
 */
export const AWS_IOT_PRESETS: Record<string, FaultPreset> = {
  connect_not_authorized: connackPreset(
    ReasonCode.NotAuthorized,
    "MQTT CONNECT is refused with CONNACK 0x87 Not authorized",
  ),
  connect_bad_credentials: connackPreset(
    ReasonCode.BadUserNameOrPassword,
    "MQTT CONNECT is refused with CONNACK 0x86 Bad User Name or Password",
  ),
  connect_quota_exceeded: connackPreset(
    ReasonCode.QuotaExceeded,
    "MQTT CONNECT is refused with CONNACK 0x97 Quota exceeded",
  ),
  publish_throttled: {
    description: "Publish answers 429 ThrottlingException and delivers nothing",
    rules: [publishFault(429, "ThrottlingException", "The rate exceeds the limit.")],
  },
  publish_unauthorized: {
    description: "Publish answers 401 UnauthorizedException and delivers nothing",
    rules: [
      publishFault(
        401,
        "UnauthorizedException",
        "You are not authorized to perform this operation.",
      ),
    ],
  },
  publish_internal_failure: {
    description: "Publish answers 500 InternalFailureException and delivers nothing",
    rules: [publishFault(500, "InternalFailureException", "An unexpected error has occurred.")],
  },
}

export type AwsIotRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
  /** IAM credentials, authorizer entries and the session quota every namespace starts with. */
  settings?: SettingsPatch
  /**
   * An in-process stand-in for a custom authorizer's Lambda function. When given, it decides
   * every MQTT CONNECT in every namespace, and `settings.authorizers` is not consulted.
   */
  authorizer?: CustomAuthorizer
}

export type AwsIotRuntime = ServiceRuntime<AwsIotAPI> & {
  /**
   * Attach an MQTT client transport. The namespace is `namespace` when given; otherwise the
   * one `PUT /__admin/credentials` maps the CONNECT's username (without its `?…` query), then
   * its client identifier, to; otherwise the default one.
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

const adminRoutes = (runtime: ServiceRuntime<AwsIotAPI>): AdminRoutes => ({
  ...brokerAdminRoutes((namespace) => runtime.instance(namespace).broker),
  "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
  "PUT /settings": ({ body, namespace }) => {
    let patch: SettingsPatch
    try {
      patch = parseSettings(body)
    } catch (error) {
      return adminError(400, error instanceof Error ? error.message : String(error))
    }
    return json(200, runtime.instance(namespace).state.update(patch))
  },
})

/**
 * The AWS IoT Core emulator with Mockingbird's full service contract: `/__admin/health`,
 * `/__admin/*`, namespaces by header, by `/__admin/ns/<name>` path prefix, or by access key
 * (`PUT /__admin/credentials {"credentials": {"<AWS_ACCESS_KEY_ID>": "<namespace>"}}`), clock
 * control, fault presets and a request journal. MQTT clients reach it through `attach`.
 */
export const createRuntime = (options: AwsIotRuntimeOptions = {}): AwsIotRuntime => {
  const adminPrefix = resolveAdminPrefix(options.adminPrefix)
  const endpoints: AwsIotRuntime["endpoints"] = {}
  // Boot controls can move the clock while the runtime is still being built.
  let built: ServiceRuntime<AwsIotAPI> | undefined
  const each = (visit: (api: AwsIotAPI) => void) => {
    if (!built) return
    for (const name of built.namespaces()) visit(built.instance(name))
  }
  const runtime: ServiceRuntime<AwsIotAPI> = createServiceRuntime<AwsIotAPI>({
    name: AWS_IOT_NAMESPACE,
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
    credential: accessKeyCredential,
    presets: AWS_IOT_PRESETS,
    create: ({ sqlite, namespace, publicNamespace, clock }) =>
      new AwsIotAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.settings ? { settings: options.settings } : {}),
        ...(options.authorizer ? { authorizer: options.authorizer } : {}),
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
            (connect) =>
              runtime.instance(
                connectNamespace(
                  runtime.credentials,
                  connect,
                  splitUsername(connect.username).username,
                ),
              ).broker,
            info,
          ),
    webSocketPath: (pathname: string) => webSocketNamespace(pathname, adminPrefix),
    stop: () => each((api) => api.broker.dropConnections()),
  })
}
