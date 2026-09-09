import { createServer } from "node:net"

const BIND_HOST = "127.0.0.1"

/**
 * Ask the OS for a free TCP port by binding an ephemeral listener, reading the
 * assigned port, and closing the listener. The port can race between release
 * and reuse, which is acceptable for mock infrastructure: consumers poll the
 * health endpoint until the server is ready.
 */
export const findFreePort = async (): Promise<number> => {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, BIND_HOST, () => {
      const address = server.address()
      if (address && typeof address === "object") {
        const { port } = address
        server.close(() => resolve(port))
        return
      }
      server.close()
      reject(new Error("Ephemeral listener did not report a port"))
    })
  })
}
