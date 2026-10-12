/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type ElevenLabsRuntime, type ElevenLabsRuntimeOptions } from "./runtime.js"

/** Port `mockingbird-elevenlabs serve` listens on when none is given. */
export const DEFAULT_PORT = 8841

export type ElevenLabsServerOptions = ElevenLabsRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type ElevenLabsServer = Listening & { runtime: ElevenLabsRuntime }

/** Serve the ElevenLabs mock over `node:http`. */
export const createServer = async (
  options: ElevenLabsServerOptions = {},
): Promise<ElevenLabsServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, {
    port: port ?? 0,
    ...(host !== undefined ? { host } : {}),
  })
  return { ...listening, runtime }
}

const list = (value: string | boolean | undefined): string[] | undefined =>
  typeof value === "string"
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : undefined

/** How `serve` (and `serve --config`) builds the ElevenLabs mock from flags. */
export const serveTarget: ServeTarget = {
  name: "elevenlabs",
  defaultPort: DEFAULT_PORT,
  options: {
    "api-key": {
      type: "string",
      value: "<key>",
      description:
        "The xi-api-key to accept (the app's ELEVENLABS_API_KEY). Default: fixture-elevenlabs-key",
    },
    voices: {
      type: "string",
      value: "<id,id,…>",
      description: "Voice ids every namespace starts with (the app's configured voices)",
    },
    models: {
      type: "string",
      value: "<id,id,…>",
      description: "Model ids every namespace starts with, e.g. eleven_multilingual_v2",
    },
  },
  create: (values, common) => {
    const key = typeof values["api-key"] === "string" ? values["api-key"] : undefined
    const voices = list(values.voices)
    const models = list(values.models)
    return createRuntime({
      ...(key ? { keys: [key] } : {}),
      ...(voices ? { voices: voices.map((voice_id) => ({ voice_id })) } : {}),
      ...(models ? { models: models.map((model_id) => ({ model_id })) } : {}),
      ...(common.adminPrefix !== undefined ? { adminPrefix: common.adminPrefix } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.adminControls !== undefined ? { adminControls: common.adminControls } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "auth: xi-api-key: <key> (default fixture-elevenlabs-key); answers are local synthetic audio",
    "namespaces: x-mockingbird-namespace, /__admin/ns/<name>/…, or PUT /__admin/credentials {<key>: <ns>}",
  ],
}
