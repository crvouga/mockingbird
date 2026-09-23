/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type GeneByGeneRuntime, type GeneByGeneRuntimeOptions } from "./runtime.js"

/** Port `mockingbird-genebygene serve` listens on when none is given. */
export const DEFAULT_PORT = 8788

export type GeneByGeneServerOptions = GeneByGeneRuntimeOptions & {
  /** Default `0`: the OS picks a free port (read it from `url` / `port`). */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type GeneByGeneServer = Listening & { runtime: GeneByGeneRuntime }

/** Serve the Gene by Gene mock (API and auth host on one port) over `node:http`. */
export const createServer = async (
  options: GeneByGeneServerOptions = {},
): Promise<GeneByGeneServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, {
    port: port ?? 0,
    ...(host !== undefined ? { host } : {}),
  })
  return { ...listening, runtime }
}

const text = (value: string | boolean | undefined) =>
  typeof value === "string" && value.length > 0 ? value : undefined

/** How `serve` (and `serve --config`) builds the Gene by Gene mock from flags. */
export const serveTarget: ServeTarget = {
  name: "genebygene",
  defaultPort: DEFAULT_PORT,
  options: {
    "webhook-url": {
      type: "string",
      value: "<url>",
      description:
        "Also deliver every notification here (e.g. http://127.0.0.1:3000/webhooks/gene-by-gene)",
    },
    "webhook-secret": {
      type: "string",
      value: "<secret>",
      description: "gxg-signature key for --webhook-url (the secret seeded into the backend's KV)",
    },
    "results-s3-endpoint": {
      type: "string",
      value: "<url>",
      description: "Write result JSON/PDF/CSV to this S3 endpoint (the stack's s3rver)",
    },
    "results-s3-bucket": {
      type: "string",
      value: "<bucket>",
      description: "Bucket for result files; resultPayload becomes s3://<bucket>/<kit>.<ext>",
    },
    "results-s3-region": { type: "string", value: "<region>", description: "Default us-east-1" },
    "results-s3-access-key-id": {
      type: "string",
      value: "<id>",
      description: "Default S3RVER",
    },
    "results-s3-secret-access-key": {
      type: "string",
      value: "<secret>",
      description: "Default S3RVER",
    },
    "client-id": {
      type: "string",
      value: "<id>",
      description: "Only issue tokens to this client id (with --client-secret); default any",
    },
    "client-secret": { type: "string", value: "<secret>", description: "See --client-id" },
    "no-kit-numbers": {
      type: "boolean",
      description:
        "Place orders without kit numbers (as staging often does); POST /__admin/orders/:id/kit-numbers mints them",
    },
  },
  create: (values, common) => {
    const url = text(values["webhook-url"])
    const secret = text(values["webhook-secret"])
    const endpoint = text(values["results-s3-endpoint"])
    const bucket = text(values["results-s3-bucket"])
    if ((endpoint === undefined) !== (bucket === undefined)) {
      throw new Error("--results-s3-endpoint and --results-s3-bucket go together")
    }
    const region = text(values["results-s3-region"])
    const accessKeyId = text(values["results-s3-access-key-id"])
    const secretAccessKey = text(values["results-s3-secret-access-key"])
    const clientId = text(values["client-id"])
    const clientSecret = text(values["client-secret"])
    return createRuntime({
      ...(url ? { webhooks: { url, ...(secret ? { secret } : {}) } } : {}),
      ...(endpoint && bucket
        ? {
            resultsS3: {
              endpoint,
              bucket,
              ...(region ? { region } : {}),
              ...(accessKeyId ? { accessKeyId } : {}),
              ...(secretAccessKey ? { secretAccessKey } : {}),
            },
          }
        : {}),
      settings: {
        ...(values["no-kit-numbers"] === true ? { generateKitNumbers: false } : {}),
        ...(clientId && clientSecret
          ? { clients: [{ client_id: clientId, client_secret: clientSecret }] }
          : {}),
      },
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "auth: POST /connect/token (form: grant_type=client_credentials, client_id, client_secret) on this same port",
    "api:  /api/v2/* with Authorization: Bearer <token>",
    "namespaces: x-mockingbird-namespace, /ns/<name>/… (API and token URL), or PUT /__admin/credentials {<client_id>: <ns>}",
  ],
}
