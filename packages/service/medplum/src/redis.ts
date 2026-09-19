import { type ChildProcess, spawn } from "node:child_process"
import { connect, type Socket } from "node:net"

const BIND_HOST = "127.0.0.1"
const READY_TIMEOUT_MS = 30000
const READY_POLL_INTERVAL_MS = 100
const STOP_GRACE_MS = 5000
const PING_TIMEOUT_MS = 1000

/**
 * Path of the `redis-server` binary to spawn. Defaults to whatever is on
 * `PATH`; override when the binary lives somewhere unusual.
 */
const binaryPath = (): string => process.env.MOCKINGBIRD_REDIS_SERVER ?? "redis-server"

const missingBinaryError = (command: string, cause: unknown): Error =>
  new Error(
    `failed to spawn "${command}". @crvouga/mockingbird-service-medplum needs a redis-server binary on PATH ` +
      `(macOS: brew install redis, Debian/Ubuntu: apt-get install redis-server), or set ` +
      `MOCKINGBIRD_REDIS_SERVER to its path. Cause: ${String(cause)}`,
  )

/** Send `PING` over a raw socket and resolve true when the server answers `+PONG`. */
const ping = async (port: number): Promise<boolean> => {
  return new Promise((resolve) => {
    let socket: Socket | undefined
    const done = (result: boolean) => {
      clearTimeout(timer)
      socket?.destroy()
      resolve(result)
    }
    const timer = setTimeout(() => done(false), PING_TIMEOUT_MS)
    socket = connect({ host: BIND_HOST, port }, () => {
      socket?.write("PING\r\n")
    })
    socket.on("data", (chunk: Buffer) => done(chunk.toString().startsWith("+PONG")))
    socket.on("error", () => done(false))
  })
}

/**
 * A `redis-server` child process bound to a fixed port on loopback, running
 * without persistence so each run starts empty and leaves no dump behind.
 * The binary comes from `PATH`, so nothing is compiled or downloaded at install time.
 */
export class RedisServerProcess {
  private child: ChildProcess | undefined
  private exited: Promise<void> | undefined

  constructor(private readonly port: number) {}

  async start(): Promise<void> {
    if (this.child) return
    const command = binaryPath()
    const child = spawn(
      command,
      [
        "--port",
        String(this.port),
        "--bind",
        BIND_HOST,
        "--save",
        "",
        "--appendonly",
        "no",
        "--daemonize",
        "no",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    )
    this.child = child

    const stderr: string[] = []
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk.toString())
      if (stderr.length > 20) stderr.shift()
    })

    let spawnError: unknown
    child.on("error", (error) => {
      spawnError = error
    })
    this.exited = new Promise<void>((resolve) => {
      child.once("close", () => resolve())
    })

    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (spawnError !== undefined) {
        this.child = undefined
        throw missingBinaryError(command, spawnError)
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        this.child = undefined
        throw new Error(
          `"${command}" exited before becoming ready (code=${child.exitCode} signal=${child.signalCode}). Last output:\n${stderr.join("")}`,
        )
      }
      if (await ping(this.port)) return
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS))
    }
    await this.stop()
    throw new Error(
      `"${command}" did not accept connections on port ${this.port} within ${READY_TIMEOUT_MS}ms`,
    )
  }

  getPort(): number {
    return this.port
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = undefined
    if (!child || child.exitCode !== null) return
    const exited = this.exited ?? Promise.resolve()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL")
        resolve()
      }, STOP_GRACE_MS)
      void exited.then(() => {
        clearTimeout(timer)
        resolve()
      })
      child.kill("SIGTERM")
    })
    this.exited = undefined
  }

  kill(): void {
    this.child?.kill("SIGKILL")
    this.child = undefined
  }
}
