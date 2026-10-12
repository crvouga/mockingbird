/// <reference types="node" />
import { readFileSync } from "node:fs"
import type { Duplex } from "node:stream"
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { memoryStream, serveMqtt } from "@crvouga/mockingbird-mqtt-broker/node"
import { type AwsIotRuntime, type AwsIotRuntimeOptions, createRuntime } from "./runtime.js"
import { parseSettings, type SettingsPatch } from "./state.js"

/** HTTP port `mockingbird-aws-iot serve` listens on when none is given. */
export const DEFAULT_PORT = 8851
/** MQTT over TCP port `mockingbird-aws-iot serve` listens on when none is given (plain TCP). */
export const DEFAULT_MQTT_PORT = 8883

export type AwsIotServerOptions = AwsIotRuntimeOptions & {
  /** HTTP port: `Publish`, `/__admin`, and MQTT over WebSocket at `/mqtt`. Default `0`. */
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

export type AwsIotServer = Listening & {
  runtime: AwsIotRuntime
  /** `mqtt://host:port`, MQTT over TCP. */
  mqttUrl: string
  mqttPort: number
  /** `ws://host:port/mqtt`, MQTT over WebSocket on the HTTP port. */
  wsUrl: string
}

/**
 * Serve the AWS IoT Core emulator in this process: `Publish` and admin routes over `node:http`,
 * MQTT over WebSocket on the same port, and MQTT over TCP on its own. Every port defaults to an
 * OS-assigned one, and `close()` stops every listener and drops every client. No TLS: point
 * clients at the `http://`, `mqtt://` and `ws://` URLs.
 */
export const createServer = async (options: AwsIotServerOptions = {}): Promise<AwsIotServer> => {
  const { port, mqttPort, host, sweepMs, ...rest } = options
  const runtime = createRuntime(rest)
  const mqtt = await serveMqtt(runtime, {
    port: mqttPort ?? 0,
    ...(host !== undefined ? { host } : {}),
    ...(sweepMs !== undefined ? { sweepMs } : {}),
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
export const connectStream = (runtime: AwsIotRuntime, namespace?: string): Duplex =>
  memoryStream((transport, info) => runtime.attach(transport, info, namespace))

const text = (value: string | boolean | undefined) =>
  typeof value === "string" ? value : undefined

/** Read a settings file: `{credentials?, authorizers?, region?, accountId?, persistentSessionExpirySeconds?}`. */
export const loadSettingsFile = (path: string): SettingsPatch => {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    throw new Error(`aws-iot settings not found: ${path}`)
  }
  try {
    return parseSettings(JSON.parse(raw))
  } catch (error) {
    throw new Error(`aws-iot settings ${path}: ${(error as Error).message}`)
  }
}

/**
 * WebSocket attachments of runtimes `serve` has built whose HTTP server is not bound yet.
 * `serve` creates a runtime, binds HTTP, then calls `listening` with the server only; a process
 * serves one AWS IoT target at a time, so the oldest entry belongs to that server.
 */
const awaitingHttp: ((http: Listening) => string)[] = []

/** How `serve` (and `serve --config`) builds the AWS IoT Core emulator from flags. */
export const serveTarget: ServeTarget = {
  name: "aws-iot",
  defaultPort: DEFAULT_PORT,
  options: {
    "mqtt-port": {
      type: "string",
      value: "<port>",
      description: "MQTT over TCP port, without TLS (0 picks a free one)",
      default: String(DEFAULT_MQTT_PORT),
    },
    credential: {
      type: "string",
      value: "<accessKeyId:secretAccessKey>",
      description: "Verify SigV4 signatures against this key (default: any signed request passes)",
    },
    settings: {
      type: "string",
      value: "<file.json>",
      description:
        "Settings every namespace starts with: credentials, authorizers, region, accountId",
    },
  },
  create: async (values, common) => {
    const file = text(values.settings)
    const credential = text(values.credential)
    const colon = credential?.indexOf(":") ?? -1
    if (credential !== undefined && colon <= 0) {
      throw new Error('--credential must look like "<accessKeyId>:<secretAccessKey>"')
    }
    const mqttPort = Number.parseInt(text(values["mqtt-port"]) ?? String(DEFAULT_MQTT_PORT), 10)
    if (!Number.isInteger(mqttPort) || mqttPort < 0 || mqttPort > 65_535) {
      throw new Error("--mqtt-port must be a port number")
    }
    const settings: SettingsPatch = file ? loadSettingsFile(file) : {}
    if (credential !== undefined) {
      settings.credentials = [
        ...(settings.credentials ?? []),
        { accessKeyId: credential.slice(0, colon), secretAccessKey: credential.slice(colon + 1) },
      ]
    }
    const runtime = createRuntime({
      settings,
      ...(common.adminPrefix !== undefined ? { adminPrefix: common.adminPrefix } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.adminControls !== undefined ? { adminControls: common.adminControls } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
    const mqtt = await serveMqtt(runtime, { port: mqttPort })
    awaitingHttp.push(mqtt.attachWebSocket)
    return runtime
  },
  listening: (http) => {
    awaitingHttp.shift()?.(http)
  },
  banner: (runtime) => {
    const { endpoints } = runtime as AwsIotRuntime
    return [
      `mqtt: ${endpoints.mqtt ?? "(not bound)"}  (MQTT 5 over TCP, no TLS)`,
      `websocket: ${endpoints.websocket ?? "(not bound)"}  (subprotocol mqtt)`,
      "publish: POST /topics/<percent-encoded topic>?qos=1, signed with SigV4 (service iotdata)",
      "namespaces: x-mockingbird-namespace, /__admin/ns/<name>/…, or PUT /__admin/credentials {<access key id | mqtt username | client id>: <ns>}",
    ]
  },
}
