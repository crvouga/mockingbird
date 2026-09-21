/// <reference types="node" />
import type { ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { type H2cListening, listenH2c } from "./h2c.js"
import { createRuntime, type SpeechRuntime, type SpeechRuntimeOptions } from "./runtime.js"
import type { TranscriptScript } from "./state.js"

/** Port `mockingbird-aws-speech serve` listens on when none is given. */
export const DEFAULT_PORT = 8797

export type SpeechServerOptions = SpeechRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type SpeechServer = H2cListening & { runtime: SpeechRuntime }

/**
 * Serve the Polly + Transcribe mock on one port that speaks h2c (the SDKs' default for
 * Polly and Transcribe Streaming, and required for their duplex streams) and HTTP/1.1
 * (Transcribe batch).
 */
export const createServer = async (options: SpeechServerOptions = {}): Promise<SpeechServer> => {
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

const loadTranscripts = async (path: string): Promise<TranscriptScript[]> => {
  const { readFile } = await import("node:fs/promises")
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown
  const list = Array.isArray(raw) ? raw : (raw as { transcripts?: unknown[] }).transcripts
  if (!Array.isArray(list)) throw new Error(`${path}: expected {"transcripts": [...]}`)
  return list.map((each, index) => {
    const item = each as TranscriptScript
    if (typeof item?.final !== "string")
      throw new Error(`${path}: transcripts[${index}].final must be a string`)
    return { ...item, id: item.id ?? `transcript_${index + 1}` }
  })
}

/**
 * How `serve` builds the speech mock from flags. `serve --config` in another service's CLI
 * listens over HTTP/1.1 only; `mockingbird-aws-speech serve` listens with h2c as well.
 */
export const serveTarget: ServeTarget = {
  name: "aws-speech",
  defaultPort: DEFAULT_PORT,
  options: {
    transcripts: {
      type: "string",
      value: "<file.json>",
      description:
        'Transcripts every namespace starts with ({"transcripts": [...]}, as PUT /__admin/transcripts)',
    },
    "default-transcript": {
      type: "string",
      value: "<text>",
      description: 'What an unscripted session or job hears (default "Hello.")',
    },
    "s3-endpoint": {
      type: "string",
      value: "<url>",
      description:
        "Write completed batch transcripts to this S3 (s3rver) at OutputBucketName/OutputKey",
    },
  },
  create: async (values, common) => {
    const transcriptsPath = text(values.transcripts)
    const defaultTranscript = text(values["default-transcript"])
    const s3 = text(values["s3-endpoint"])
    return createRuntime({
      ...(transcriptsPath ? { transcripts: await loadTranscripts(transcriptsPath) } : {}),
      ...(defaultTranscript !== undefined ? { settings: { defaultTranscript } } : {}),
      ...(s3 ? { transcriptStore: { endpoint: s3 } } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }) as never
  },
  banner: () => [
    "point the app at it: AWS_ENDPOINT_URL_POLLY / AWS_ENDPOINT_URL_TRANSCRIBE_STREAMING / AWS_ENDPOINT_URL_TRANSCRIBE = this URL",
    "protocols: h2c (prior knowledge) and HTTP/1.1 on the same port",
    "namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<AWS_ACCESS_KEY_ID>: <ns>}",
    'transcripts: PUT /__admin/transcripts {match: {sessionIndex} | {any: true}, partials: [...], final: "..."}',
  ],
}

export type { H2cListening, H2cListenOptions } from "./h2c.js"
export { listenH2c } from "./h2c.js"
