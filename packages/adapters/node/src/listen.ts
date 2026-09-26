import type { Server } from "node:http"
import type { FetchAPI } from "@crvouga/mockingbird-core"
import { serve } from "./serve.js"

export type ListenOptions = {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`: a mock should not be reachable off the machine by accident. */
  host?: string
}

/** A running server, with the address it actually bound. */
export type Listening = {
  url: string
  port: number
  host: string
  server: Server
  close(): Promise<void>
}

export const listen = async (api: FetchAPI, options: ListenOptions = {}): Promise<Listening> => {
  const host = options.host ?? "127.0.0.1"
  const server = await serve(api, { port: options.port ?? 0, host })
  const address = server.address()
  const port = typeof address === "object" && address !== null ? address.port : (options.port ?? 0)
  const shown = host.includes(":") ? `[${host}]` : host
  return {
    url: `http://${shown}:${port}`,
    port,
    host,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Stop accepting first, then drop keep-alive sockets so close() can finish.
        server.close((error) => {
          if (error && (error as { code?: string }).code !== "ERR_SERVER_NOT_RUNNING") reject(error)
          else resolve()
        })
        server.closeAllConnections?.()
      }),
  }
}
