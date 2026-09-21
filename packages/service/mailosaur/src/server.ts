/// <reference types="node" />
import { writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import {
  connect,
  createServer as createNetServer,
  type Server as NetServer,
  type Socket,
} from "node:net"
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls"
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type MailosaurRuntime, type MailosaurRuntimeOptions } from "./runtime.js"
import { type SelfSignedCertificate, selfSignedCertificate } from "./tls.js"

export type { SelfSignedCertificate } from "./tls.js"
export { selfSignedCertificate } from "./tls.js"

/** Port `mockingbird-mailosaur serve` listens on when none is given. */
export const DEFAULT_PORT = 8793

export type TlsOptions = {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** PEM certificate and key; default: a fresh self-signed one for localhost, 127.0.0.1 and mailosaur.com. */
  cert?: string
  key?: string
}

export type MailosaurServerOptions = MailosaurRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
  /**
   * Also answer over HTTPS. The `mailosaur` SDK only speaks HTTPS (it calls `https.request`
   * whatever its base URL says), so pass `tls: true` whenever the SDK is the client.
   */
  tls?: boolean | TlsOptions
}

export type MailosaurServer = Listening & {
  runtime: MailosaurRuntime
  /** `https://127.0.0.1:<port>` when `tls` was asked for. */
  tlsUrl?: string
  /** The same port as an HTTP proxy (`HTTPS_PROXY`), how the unmodified SDK reaches the mock. */
  proxyUrl?: string
  /** The PEM certificate the HTTPS listener presents (trust it with `ca` / `NODE_EXTRA_CA_CERTS`). */
  cert?: string
}

type Endpoint = { host: string; port: number }
type Door = { port: number; close(): Promise<void> }

const listenOn = async (server: NetServer | TlsServer, bind: Endpoint): Promise<number> => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(bind.port, bind.host, resolve)
  })
  const address = server.address()
  return typeof address === "object" && address !== null ? address.port : bind.port
}

/** Pipe `socket` (after replaying `head`) to `target`, tearing both down together. */
const tunnel = (socket: Socket, target: Endpoint, head: Uint8Array, sockets: Set<Socket>) => {
  const inner = connect(target.port, target.host)
  // Each hop forwards small TLS records; Nagle plus delayed ACKs would stall them per hop.
  socket.setNoDelay(true)
  inner.setNoDelay(true)
  sockets.add(socket)
  sockets.add(inner)
  const close = () => {
    socket.destroy()
    inner.destroy()
    sockets.delete(socket)
    sockets.delete(inner)
  }
  socket.on("error", close).on("close", close)
  inner.on("error", close).on("close", close)
  if (head.length > 0) inner.write(head)
  socket.pipe(inner)
  inner.pipe(socket)
  socket.resume()
}

/**
 * One port that speaks HTTPS, plain HTTP and the HTTP `CONNECT` proxy method, all onto the
 * runtime's plain HTTP listener `upstream`:
 *
 * - a TLS ClientHello is terminated with `certificate` (the SDK's direct HTTPS);
 * - `CONNECT <any host>:<port>` is answered `200` and the tunnel is terminated the same way.
 *   The `mailosaur` SDK drops the port of its base URL (it always connects to 443), so this
 *   is how an unmodified SDK reaches the mock: `HTTPS_PROXY=http://127.0.0.1:<port>` when the
 *   client is constructed, and the certificate trusted (`NODE_EXTRA_CA_CERTS`). Every CONNECT
 *   target is tunnelled into the mock, never to the network;
 * - anything else is plain HTTP.
 */
const secureDoor = async (
  certificate: SelfSignedCertificate,
  upstream: Endpoint,
  bind: Endpoint,
): Promise<Door> => {
  const sockets = new Set<Socket>()
  const terminator = createTlsServer({ cert: certificate.cert, key: certificate.key }, (socket) =>
    tunnel(socket, upstream, new Uint8Array(), sockets),
  )
  const tlsPort = await listenOn(terminator, { host: "127.0.0.1", port: 0 })
  const decrypted = { host: "127.0.0.1", port: tlsPort }
  const door = createNetServer((socket) => {
    let buffered = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      if (buffered[0] === 0x16) {
        socket.off("data", onData)
        socket.pause()
        tunnel(socket, decrypted, buffered, sockets)
        return
      }
      const end = buffered.indexOf("\r\n\r\n")
      if (end < 0 && buffered.length < 16_384) return
      socket.off("data", onData)
      socket.pause()
      if (/^CONNECT /i.test(buffered.subarray(0, 8).toString("latin1"))) {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        tunnel(socket, decrypted, buffered.subarray(end + 4), sockets)
      } else {
        tunnel(socket, upstream, buffered, sockets)
      }
    }
    socket.on("data", onData)
    socket.on("error", () => socket.destroy())
  })
  const port = await listenOn(door, bind)
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        terminator.close()
        door.close(() => resolve())
      }),
  }
}

/** The hosts the generated certificate names: loopback, and the SDK's default host. */
export const CERTIFICATE_HOSTS = ["localhost", "127.0.0.1", "mailosaur.com"] as const

const certificateFor = (tls: TlsOptions): SelfSignedCertificate =>
  tls.cert && tls.key ? { cert: tls.cert, key: tls.key } : selfSignedCertificate(CERTIFICATE_HOSTS)

/** Serve the Mailosaur mock over `node:http`, and over HTTPS too when `tls` is set. */
export const createServer = async (
  options: MailosaurServerOptions = {},
): Promise<MailosaurServer> => {
  const { port, host, tls, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, {
    port: port ?? 0,
    ...(host !== undefined ? { host } : {}),
  })
  if (!tls) return { ...listening, runtime }
  const options_ = tls === true ? {} : tls
  const certificate = certificateFor(options_)
  const door = await secureDoor(
    certificate,
    { host: listening.host, port: listening.port },
    { host: listening.host, port: options_.port ?? 0 },
  )
  const shown = listening.host.includes(":") ? `[${listening.host}]` : listening.host
  return {
    ...listening,
    runtime,
    tlsUrl: `https://${shown}:${door.port}`,
    proxyUrl: `http://${shown}:${door.port}`,
    cert: certificate.cert,
    close: async () => {
      await door.close()
      await listening.close()
    },
  }
}

const text = (value: string | boolean | undefined) =>
  typeof value === "string" ? value : undefined

/** How `serve` (and `serve --config`) builds the Mailosaur mock from flags. */
export const serveTarget: ServeTarget = {
  name: "mailosaur",
  defaultPort: DEFAULT_PORT,
  options: {
    "tls-port": {
      type: "string",
      value: "<port>",
      description:
        "Also serve HTTPS and an HTTP CONNECT proxy on this port (the mailosaur SDK only speaks HTTPS, always to port 443): construct the SDK with HTTPS_PROXY=http://127.0.0.1:<port>",
    },
    "tls-cert": { type: "string", value: "<pem file>", description: "Certificate for --tls-port" },
    "tls-key": { type: "string", value: "<pem file>", description: "Private key for --tls-port" },
    "tls-cert-out": {
      type: "string",
      value: "<file>",
      description:
        "Write the generated self-signed certificate here (use it as NODE_EXTRA_CA_CERTS for the app)",
    },
    "poll-delay": {
      type: "string",
      value: "<ms[,ms…]>",
      description: "x-ms-delay the SDK waits between empty polls (default 20)",
    },
  },
  create: async (values, common) => {
    const delays = text(values["poll-delay"])
    if (delays && !/^\d+(,\d+)*$/.test(delays)) {
      throw new Error("--poll-delay must look like 20 or 20,50,100")
    }
    const runtime = createRuntime({
      ...(delays ? { settings: { pollDelaysMs: delays.split(",").map(Number) } } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
    const tlsPort = text(values["tls-port"])
    if (tlsPort !== undefined) {
      const certFile = text(values["tls-cert"])
      const keyFile = text(values["tls-key"])
      if ((certFile === undefined) !== (keyFile === undefined)) {
        throw new Error("--tls-cert and --tls-key go together")
      }
      const certificate = certificateFor(
        certFile && keyFile
          ? { cert: await readFile(certFile, "utf8"), key: await readFile(keyFile, "utf8") }
          : {},
      )
      const out = text(values["tls-cert-out"])
      if (out) writeFileSync(out, certificate.cert)
      // The secure door fronts its own loopback HTTP listener over the same runtime.
      const inner = await listen(runtime, { port: 0 })
      const door = await secureDoor(
        certificate,
        { host: inner.host, port: inner.port },
        { host: "127.0.0.1", port: Number(tlsPort) },
      )
      console.log(
        `mailosaur HTTPS + CONNECT proxy on 127.0.0.1:${door.port} (HTTPS_PROXY=http://127.0.0.1:${door.port})`,
      )
    }
    return runtime
  },
  banner: () => [
    "auth: Authorization: Basic base64(<api key>:) — any key; the SDK needs HTTPS (--tls-port)",
    "ingest: POST /__admin/ingest {to, from?, subject?, html?, text?, server?, type?}",
    "namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<api key>: <ns>}",
  ],
}
