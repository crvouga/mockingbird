/// <reference types="node" />
import { type Listening, type ServeTarget, serve } from "@crvouga/mockingbird-adapter-node"
import { S3_MAX_UPLOAD_BYTES } from "./index.js"
import { createRuntime, type S3Runtime, type S3RuntimeOptions } from "./runtime.js"
export const DEFAULT_PORT = 8812
export type S3ServerOptions = S3RuntimeOptions & {
  port?: number
  host?: string
  /** Largest request body accepted. Default 5 GiB, the most S3 takes in one PUT or part. */
  maxBodyBytes?: number
}
export const createServer = async (
  options: S3ServerOptions = {},
): Promise<Listening & { runtime: S3Runtime }> => {
  const { port, host, maxBodyBytes, ...rest } = options
  const runtime = createRuntime(rest)
  const bind = host ?? "127.0.0.1"
  const server = await serve(runtime, {
    port: port ?? 0,
    host: bind,
    maxBodyBytes: maxBodyBytes ?? S3_MAX_UPLOAD_BYTES,
  })
  const address = server.address()
  const bound = typeof address === "object" && address !== null ? address.port : (port ?? 0)
  return {
    url: `http://${bind.includes(":") ? `[${bind}]` : bind}:${bound}`,
    port: bound,
    host: bind,
    server,
    runtime,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error && (error as { code?: string }).code !== "ERR_SERVER_NOT_RUNNING") reject(error)
          else resolve()
        })
        server.closeAllConnections?.()
      }),
  }
}
export const serveTarget: ServeTarget = {
  name: "s3",
  defaultPort: DEFAULT_PORT,
  maxBodyBytes: S3_MAX_UPLOAD_BYTES,
  options: {
    "virtual-host": {
      type: "string",
      value: "<hosts>",
      description:
        "Comma-separated base hosts for virtual-hosted-style requests: Host <bucket>.<host> names the bucket (default localhost; empty for path-style only)",
    },
  },
  create: (values, common) =>
    createRuntime({
      ...(common.adminPrefix !== undefined ? { adminPrefix: common.adminPrefix } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.adminControls !== undefined ? { adminControls: common.adminControls } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
      ...(typeof values["virtual-host"] === "string"
        ? {
            virtualHosts: values["virtual-host"]
              .split(",")
              .map((host) => host.trim())
              .filter(Boolean),
          }
        : {}),
    }),
  banner: () => [
    "AWS SDK endpoint: set endpoint to this URL; forcePathStyle=true, or a client that addresses <bucket>.localhost",
    "admin: POST /__admin/objects; GET /__admin/objects",
  ],
}
