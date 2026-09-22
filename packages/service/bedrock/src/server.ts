/// <reference types="node" />
import type { ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { type H2cListening, listenH2c } from "./h2c.js"
import { type BedrockRuntime, type BedrockRuntimeOptions, createRuntime } from "./runtime.js"
import { parseScript, type Script } from "./scripts.js"

/** Port `mockingbird-bedrock serve` listens on when none is given. */
export const DEFAULT_PORT = 8796

export type BedrockServerOptions = BedrockRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type BedrockServer = H2cListening & { runtime: BedrockRuntime }

/**
 * Serve the Bedrock mock on one port that speaks both h2c (the AWS SDK's default
 * `NodeHttp2Handler`, and Nova Sonic's duplex stream) and HTTP/1.1 (the AI SDK, AgentCore).
 */
export const createServer = async (options: BedrockServerOptions = {}): Promise<BedrockServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listenH2c(runtime, {
    port: port ?? 0,
    ...(host !== undefined ? { host } : {}),
  })
  return { ...listening, runtime }
}

const text = (value: string | boolean | undefined) =>
  typeof value === "string" ? value : undefined

/** Scripts from `--scripts <file.json>` (Node only). */
const loadScripts = async (path: string): Promise<Script[]> => {
  const { readFile } = await import("node:fs/promises")
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown
  const list = Array.isArray(raw) ? raw : (raw as { scripts?: unknown[] }).scripts
  if (!Array.isArray(list)) throw new Error(`${path}: expected {"scripts": [...]}`)
  return list.map((each, index) => {
    const parsed = parseScript(each, index)
    if (typeof parsed === "string") throw new Error(`${path}: ${parsed}`)
    return parsed
  })
}

/**
 * How `serve` builds the Bedrock mock from flags. `serve --config` in another service's CLI
 * listens over HTTP/1.1 only; `mockingbird-bedrock serve` listens with h2c as well.
 */
export const serveTarget: ServeTarget = {
  name: "bedrock",
  defaultPort: DEFAULT_PORT,
  options: {
    scripts: {
      type: "string",
      value: "<file.json>",
      description:
        'Scripts every namespace starts with ({"scripts": [...]}, as PUT /__admin/scripts)',
    },
    "default-text": {
      type: "string",
      value: "<text>",
      description: 'What an unscripted chat call answers (default "OK.")',
    },
  },
  create: async (values, common) => {
    const scriptsPath = text(values.scripts)
    const defaultText = text(values["default-text"])
    return createRuntime({
      ...(scriptsPath ? { scripts: await loadScripts(scriptsPath) } : {}),
      ...(defaultText !== undefined ? { settings: { defaultText } } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }) as never
  },
  banner: () => [
    "point the app at it: AWS_ENDPOINT_URL_BEDROCK_RUNTIME / AWS_ENDPOINT_URL_BEDROCK_AGENTCORE = this URL",
    "protocols: h2c (prior knowledge) and HTTP/1.1 on the same port",
    "namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<AWS_ACCESS_KEY_ID>: <ns>}",
    "scripts: PUT /__admin/scripts {scripts: [{id, match, turns}]}",
  ],
}

export type { H2cListening, H2cListenOptions } from "./h2c.js"
export { listenH2c } from "./h2c.js"
