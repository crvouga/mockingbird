/// <reference types="node" />
import type { Duplex } from "node:stream"
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { memoryStream, serveMqtt } from "@crvouga/mockingbird-mqtt-broker/node"
import { createRuntime, type EmqxRuntime, type EmqxRuntimeOptions } from "./runtime.js"

/** HTTP port `mockingbird-emqx serve` listens on when none is given. */
export const DEFAULT_PORT = 8850
/** MQTT over TCP port `mockingbird-emqx serve` listens on when none is given. */
export const DEFAULT_MQTT_PORT = 1883

/** `supported_subprotocols` of EMQX's WebSocket listener. */
const SUBPROTOCOLS = ["mqtt", "mqtt-v3", "mqtt-v3.1.1", "mqtt-v5"]

export type EmqxServerOptions = EmqxRuntimeOptions & {
  /** HTTP port: the REST API, `/__admin`, and MQTT over WebSocket at `/mqtt`. Default `0`. */
  port?: number
  /** MQTT over TCP port. Default `0`: the OS picks a free port. */
  mqttPort?: number
  /** Default `127.0.0.1`. */
  host?: string
  /**
   * How often (real ms) expiries are settled when nothing else touches the broker. The served
   * emulator uses 1000; a suite that moves the clock through `/__admin/clock` needs none.
   */
  sweepMs?: number
}

export type EmqxServer = Listening & {
  runtime: EmqxRuntime
  /** `mqtt://host:port`, MQTT over TCP. */
  mqttUrl: string
  mqttPort: number
  /** `ws://host:port/mqtt`, MQTT over WebSocket on the HTTP port. */
  wsUrl: string
}

/**
 * Serve the EMQX emulator in this process: the REST API and admin routes over `node:http`,
 * MQTT over WebSocket on the same port, and MQTT over TCP on its own. Every port defaults to
 * an OS-assigned one, and `close()` stops every listener and drops every client.
 */
export const createServer = async (options: EmqxServerOptions = {}): Promise<EmqxServer> => {
  const { port, mqttPort, host, sweepMs, ...rest } = options
  const runtime = createRuntime(rest)
  const mqtt = await serveMqtt(runtime, {
    port: mqttPort ?? 0,
    ...(host !== undefined ? { host } : {}),
    ...(sweepMs !== undefined ? { sweepMs } : {}),
    subprotocols: SUBPROTOCOLS,
  })
  let listening: Listening
  try {
    listening = await listen(runtime, {
      port: port ?? 0,
      ...(host !== undefined ? { host } : {}),
    })
  } catch (error) {
    runtime.stop()
    throw error
  }
  const wsUrl = mqtt.attachWebSocket(listening)
  return {
    ...listening,
    runtime,
    mqttUrl: mqtt.tcp.url,
    mqttPort: mqtt.tcp.port,
    wsUrl,
    close: async () => {
      runtime.stop()
      await mqtt.tcp.close()
      await listening.close()
    },
  }
}

/**
 * An in-process MQTT connection as a Node stream, with no socket:
 * `new MqttClient(() => connectStream(runtime), { protocolVersion: 5, … })` with `mqtt`.
 */
export const connectStream = (runtime: EmqxRuntime, namespace?: string): Duplex =>
  memoryStream((transport, info) => runtime.attach(transport, info, namespace))

const text = (value: string | boolean | undefined) =>
  typeof value === "string" ? value : undefined

const pair = (flag: string, value: string | undefined): [string, string] | undefined => {
  if (value === undefined) return undefined
  const colon = value.indexOf(":")
  if (colon <= 0) throw new Error(`--${flag} must look like "<name>:<secret>"`)
  return [value.slice(0, colon), value.slice(colon + 1)]
}

/**
 * Runtimes `serve` has built whose HTTP server is not bound yet. `serve` creates a runtime,
 * binds HTTP, then calls `listening` with the server only; a process serves one EMQX target at
 * a time, so the oldest entry is that server's runtime.
 */
const awaitingHttp: ((http: Listening) => string)[] = []

/** How `serve` (and `serve --config`) builds the EMQX emulator from flags. */
export const serveTarget: ServeTarget = {
  name: "emqx",
  defaultPort: DEFAULT_PORT,
  options: {
    "mqtt-port": {
      type: "string",
      value: "<port>",
      description: "MQTT over TCP port (0 picks a free one)",
      default: String(DEFAULT_MQTT_PORT),
    },
    "api-key": {
      type: "string",
      value: "<key:secret>",
      description: "Only accept this REST API key and secret (default: any pair)",
    },
    "mqtt-user": {
      type: "string",
      value: "<username:password>",
      description: "Add this user to the built-in database authenticator",
    },
    "jwt-secret": {
      type: "string",
      value: "<secret>",
      description: "Enable the JWT authenticator (HS256/384/512, token in the password)",
    },
    "no-match": {
      type: "string",
      value: "<allow|deny>",
      description: "authorization.no_match: what applies when no ACL rule decides",
      default: "allow",
    },
  },
  create: async (values, common) => {
    const apiKey = pair("api-key", text(values["api-key"]))
    const user = pair("mqtt-user", text(values["mqtt-user"]))
    const secret = text(values["jwt-secret"])
    const noMatch = text(values["no-match"]) ?? "allow"
    if (noMatch !== "allow" && noMatch !== "deny") {
      throw new Error('--no-match must be "allow" or "deny"')
    }
    const mqttPort = Number.parseInt(text(values["mqtt-port"]) ?? String(DEFAULT_MQTT_PORT), 10)
    if (!Number.isInteger(mqttPort) || mqttPort < 0 || mqttPort > 65_535) {
      throw new Error("--mqtt-port must be a port number")
    }
    const runtime = createRuntime({
      settings: {
        ...(apiKey ? { apiKeys: [{ key: apiKey[0], secret: apiKey[1] }] } : {}),
        ...(user ? { users: [{ username: user[0], password: user[1] }] } : {}),
        ...(secret ? { jwt: { secret } } : {}),
        authorization: { noMatch },
      },
      ...(common.adminPrefix !== undefined ? { adminPrefix: common.adminPrefix } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.adminControls !== undefined ? { adminControls: common.adminControls } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
    const mqtt = await serveMqtt(runtime, { port: mqttPort, subprotocols: SUBPROTOCOLS })
    awaitingHttp.push(mqtt.attachWebSocket)
    return runtime
  },
  listening: (http) => {
    awaitingHttp.shift()?.(http)
  },
  banner: (runtime) => {
    const { endpoints } = runtime as EmqxRuntime
    return [
      `mqtt: ${endpoints.mqtt ?? "(not bound)"}  (MQTT 5 over TCP)`,
      `websocket: ${endpoints.websocket ?? "(not bound)"}  (subprotocol mqtt)`,
      "rest: Authorization: Basic <api key>:<secret> on POST /api/v5/publish and DELETE /api/v5/clients/{clientid}",
      "namespaces: x-mockingbird-namespace, /__admin/ns/<name>/…, or PUT /__admin/credentials {<api key | mqtt username | client id>: <ns>}",
    ]
  },
}
