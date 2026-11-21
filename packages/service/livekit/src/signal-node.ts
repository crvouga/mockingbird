import type { IncomingMessage, Server } from "node:http"
import { WebSocketServer } from "ws"
import { createBrowserSignalServer } from "./browser.js"
import type { LiveKitRuntime } from "./runtime.js"
import type { AudioFactory } from "./signal-audio.js"

export type NodeSignalOptions = {
  /** Node supplies no WebRTC implementation; the host must inject one explicitly. */
  createPeerConnection: () => RTCPeerConnection
  createMediaStream?: (tracks: MediaStreamTrack[]) => MediaStream
  createAudio?: AudioFactory
}

export function createNodeSignals(runtime: LiveKitRuntime, options: NodeSignalOptions) {
  const namespaces = new Map<string, ReturnType<typeof createBrowserSignalServer>>()
  const get = (url: URL, namespace?: string) => {
    const name = namespace ?? url.searchParams.get("namespace") ?? "default"
    let signal = namespaces.get(name)
    if (!signal) {
      signal = createBrowserSignalServer({
        api: runtime.instance(name),
        createPeerConnection: options.createPeerConnection,
        ...(options.createMediaStream ? { createMediaStream: options.createMediaStream } : {}),
        ...(options.createAudio ? { createAudio: options.createAudio } : {}),
      })
      namespaces.set(name, signal)
    }
    return signal
  }
  const sockets = new WebSocketServer({ noServer: true })
  let attached: Server | undefined
  const upgrade = async (
    request: IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ) => {
    socket.on("error", () => socket.destroy())
    try {
      const url = new URL(request.url ?? "/", "http://mock")
      if (url.pathname !== "/rtc") {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n")
        return
      }
      const signal = get(
        url,
        typeof request.headers["x-mockingbird-namespace"] === "string"
          ? request.headers["x-mockingbird-namespace"]
          : undefined,
      )
      const validation = await signal.validate(url)
      if (!validation.ok) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n")
        return
      }
      if (socket.destroyed) return
      sockets.handleUpgrade(request, socket, head, (ws) => {
        void signal
          .accept({
            url,
            accept() {},
            drop: () => ws.terminate(),
            refuse: () => ws.close(1008, "Refused"),
            close: (code = 1000, reason = "") => ws.close(code, reason),
            deliver: (bytes) => {
              if (ws.readyState === ws.OPEN) ws.send(bytes)
            },
            onMessage: (listener) => {
              ws.on("message", (bytes, binary) => {
                if (binary)
                  listener(
                    new Uint8Array(
                      Buffer.isBuffer(bytes)
                        ? bytes
                        : bytes instanceof ArrayBuffer
                          ? bytes
                          : Buffer.concat(bytes),
                    ),
                  )
                else ws.close(1003, "Binary signaling required")
              })
            },
            onClose: (listener) => {
              ws.once("close", listener)
            },
          })
          .catch(() => ws.close(1011, "Signal initialization failed"))
        ws.on("error", () => ws.terminate())
      })
    } catch {
      socket.destroy()
    }
  }
  return {
    attach(server: Server) {
      if (attached) throw new Error("Signaling is already attached")
      attached = server
      server.on("upgrade", upgrade)
    },
    validate(request: Request) {
      const url = new URL(request.url)
      return get(url, request.headers.get("x-mockingbird-namespace") ?? undefined).validate(url)
    },
    async close() {
      attached?.off("upgrade", upgrade)
      const closing = Promise.all([...namespaces.values()].map((signal) => signal.close()))
      for (const socket of sockets.clients) socket.terminate()
      sockets.close()
      namespaces.clear()
      await closing
    },
  }
}
