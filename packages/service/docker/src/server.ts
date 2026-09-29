/// <reference types="node" />
import type { Listening, ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { type AttachHandshakeOptions, createAttachHandshake } from "./attach.js"
import { createRuntime, type DockerRuntime, type DockerRuntimeOptions } from "./runtime.js"
import type { AttachStreamOptions, DockerAttachment } from "./streams.js"

export type { AttachStreamOptions, DockerAttachment } from "./streams.js"

import { listenDocker, type TransportOptions } from "./transport.js"

export const DEFAULT_PORT = 8826
export type DockerServerOptions = Omit<DockerRuntimeOptions, "onAttach"> &
  TransportOptions & {
    attachHandshake?: AttachHandshakeOptions
    attachStreams?: AttachStreamOptions
  }
export type DockerServer = Listening & {
  runtime: DockerRuntime
  socketPath?: string
  attachments(): DockerAttachment[]
}

/** Node-only bounded HTTP transport over TCP or a test-owned Unix socket. */
export const createServer = async (options: DockerServerOptions = {}): Promise<DockerServer> => {
  const {
    port,
    host,
    socketPath,
    maxBodyBytes,
    bodyTimeoutMs,
    maxConnections,
    attachHandshake,
    attachStreams,
    ...rest
  } = options
  const attach = createAttachHandshake(attachHandshake, attachStreams)
  const runtime = createRuntime({ ...rest, onAttach: attach.prepare })
  try {
    const listening = await listenDocker(
      runtime,
      {
        ...(port !== undefined ? { port } : {}),
        ...(host !== undefined ? { host } : {}),
        ...(socketPath !== undefined ? { socketPath } : {}),
        ...(maxBodyBytes !== undefined ? { maxBodyBytes } : {}),
        ...(bodyTimeoutMs !== undefined ? { bodyTimeoutMs } : {}),
        ...(maxConnections !== undefined ? { maxConnections } : {}),
      },
      (req, socket, head) => attach.upgrade(runtime, req, socket, head),
    )
    return { ...listening, runtime, attachments: attach.attachments }
  } catch (error) {
    runtime.close()
    throw error
  }
}

export const serveTarget: ServeTarget = {
  name: "docker",
  defaultPort: DEFAULT_PORT,
  create: (_values, common) =>
    createRuntime({
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }),
  banner: () => ["Docker lifecycle: explicit simulated completion; no image execution or attach"],
}
