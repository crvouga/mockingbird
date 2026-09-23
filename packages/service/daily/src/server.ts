/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import type { TranscriptStore } from "./index.js"
import { createRuntime, type DailyRuntime, type DailyRuntimeOptions } from "./runtime.js"
import type { Settings } from "./state.js"

/** Port `mockingbird-daily serve` listens on when none is given. */
export const DEFAULT_PORT = 8800

export type DailyServerOptions = DailyRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type DailyServer = Listening & { runtime: DailyRuntime }

/** Serve the Daily mock over `node:http`. */
export const createServer = async (options: DailyServerOptions = {}): Promise<DailyServer> => {
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

/** How `serve` (and `serve --config`) builds the Daily mock from flags. */
export const serveTarget: ServeTarget = {
  name: "daily",
  defaultPort: DEFAULT_PORT,
  options: {
    "webhook-url": {
      type: "string",
      value: "<url>",
      description: "Deliver webhooks here (e.g. http://127.0.0.1:4000/v1/webhooks/daily)",
    },
    "webhook-secret": {
      type: "string",
      value: "<secret>",
      description: "Sign x-webhook-signature with this (the EMR's DAILY_WEBHOOK_SECRET)",
    },
    "api-key": {
      type: "string",
      value: "<key>",
      description: "Only accept this DAILY_API_KEY (default: any bearer key)",
    },
    "domain-id": {
      type: "string",
      value: "<uuid>",
      description: "DAILY_API_DOMAIN_ID, stamped as `d` in minted tokens",
    },
    "room-url-base": {
      type: "string",
      value: "<url>",
      description: "Room URLs are <base><name> (e.g. the member app's EXPO_PUBLIC_DAILY_BASE_URL)",
    },
    "s3-endpoint": {
      type: "string",
      value: "<url>",
      description:
        "Write session transcripts to this S3 (s3rver/MinIO), e.g. http://127.0.0.1:4569",
    },
    "s3-bucket": {
      type: "string",
      value: "<bucket>",
      description: "Transcript bucket (the EMR's S3 bucket name)",
    },
    "s3-region": { type: "string", value: "<region>", description: "Default us-east-1" },
    "s3-access-key-id": {
      type: "string",
      value: "<id>",
      description: "Default S3RVER (env AWS_ACCESS_KEY_ID)",
    },
    "s3-secret-access-key": {
      type: "string",
      value: "<secret>",
      description: "Default S3RVER (env AWS_SECRET_ACCESS_KEY)",
    },
    "transcript-key-pattern": {
      type: "string",
      value: "<pattern>",
      description: "Default {roomName}/{sessionId}.json (DAILY_TRANSCRIPT_S3_KEY_PATTERN)",
    },
  },
  create: (values, common) => {
    const url = text(values["webhook-url"])
    const secret = text(values["webhook-secret"])
    const apiKey = text(values["api-key"])
    const domainId = text(values["domain-id"])
    const roomUrlBase = text(values["room-url-base"])
    const endpoint = text(values["s3-endpoint"])
    const bucket = text(values["s3-bucket"])
    if ((endpoint === undefined) !== (bucket === undefined)) {
      throw new Error("--s3-endpoint and --s3-bucket go together")
    }
    const region = text(values["s3-region"])
    const accessKeyId = text(values["s3-access-key-id"]) ?? process.env.AWS_ACCESS_KEY_ID
    const secretAccessKey =
      text(values["s3-secret-access-key"]) ?? process.env.AWS_SECRET_ACCESS_KEY
    const keyPattern = text(values["transcript-key-pattern"])
    const transcripts: TranscriptStore | undefined =
      endpoint && bucket
        ? {
            endpoint,
            bucket,
            ...(region ? { region } : {}),
            ...(accessKeyId ? { accessKeyId } : {}),
            ...(secretAccessKey ? { secretAccessKey } : {}),
            ...(keyPattern ? { keyPattern } : {}),
          }
        : undefined
    const settings: Partial<Settings> = {
      ...(apiKey ? { apiKeys: [apiKey] } : {}),
      ...(domainId ? { domainId } : {}),
      ...(roomUrlBase ? { roomUrlBase } : {}),
    }
    return createRuntime({
      ...(url ? { webhooks: { url, ...(secret ? { secret } : {}) } } : {}),
      ...(transcripts ? { transcripts } : {}),
      settings,
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "auth: Authorization: Bearer <DAILY_API_KEY>; tokens are HS256 JWTs signed with it",
    "calls: POST /__admin/rooms/<name>/session {participants, durationSec, transcript?} → transcription.stopped",
    "namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<DAILY_API_KEY>: <ns>}",
  ],
}
