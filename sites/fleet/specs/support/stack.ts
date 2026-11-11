/**
 * The system under test and everything it depends on, with no containers: the fleet server as a
 * child process, wired to Mockingbird's own emulators running in server mode (PostgreSQL wire
 * protocol, S3, an OTLP collector). Each stack gets fresh emulators on free ports, so stacks are
 * isolated from one another and from anything else on the machine.
 */
import { type ChildProcess, spawn } from "node:child_process"
import { createServer } from "node:net"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
export const PACKAGE_ROOT = join(here, "../..")
export const REPO_ROOT = join(PACKAGE_ROOT, "../..")
export const OPERATOR_TOKEN = "spec-operator-token-0123456789abcdef0123"
export const S3_BUCKET = "spec-bucket"

const emulatorCli = (name: string, cli = "cli.js") =>
  join(REPO_ROOT, "packages/service", name, "dist", cli)

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0))
    })
  })
}

export type Process = {
  child: ChildProcess
  /** Everything the process wrote to stdout and stderr so far. */
  output(): string
  /** Resolves with the exit code once the process ends. */
  exited: Promise<number>
  stop(signal?: NodeJS.Signals): Promise<number>
}

/** Start a child process with exactly the given environment (plus PATH), capturing its output. */
export function start(command: string, args: string[], env: Record<string, string> = {}): Process {
  const child = spawn(command, args, {
    cwd: PACKAGE_ROOT,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let text = ""
  child.stdout?.on("data", (chunk) => {
    text += chunk
  })
  child.stderr?.on("data", (chunk) => {
    text += chunk
  })
  const exited = new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? -1)))
  return {
    child,
    output: () => text,
    exited,
    async stop(signal = "SIGTERM") {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal)
      return exited
    },
  }
}

async function until(probe: () => Promise<boolean>, what: string, process?: Process) {
  for (let attempt = 0; attempt < 450; attempt++) {
    if (await probe().catch(() => false)) return
    if (process && process.child.exitCode !== null)
      throw new Error(`${what} exited early:\n${process.output()}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${what} did not become ready:\n${process?.output() ?? ""}`)
}

export type Emulators = {
  /** postgres:// URL of the PostgreSQL emulator. */
  databaseUrl: string
  /** Base URL of the S3 emulator; the bucket {@link S3_BUCKET} already exists. */
  s3Url: string
  /** Base URL of the OTLP collector emulator (unauthenticated ingest). */
  otelUrl: string
  stop(): Promise<void>
}

/** Start the PostgreSQL, S3 and OTLP emulators in server mode. */
export async function startEmulators(): Promise<Emulators> {
  const [pgPort, s3Port, otelPort] = await Promise.all([freePort(), freePort(), freePort()])
  const databaseUrl = `postgres://fleet:fleet@127.0.0.1:${pgPort}/fleet`
  const s3Url = `http://127.0.0.1:${s3Port}`
  const otelUrl = `http://127.0.0.1:${otelPort}`
  const processes = [
    start("bun", [
      emulatorCli("postgres", "wire/cli.js"),
      "serve",
      databaseUrl,
      "--port",
      String(pgPort),
    ]),
    start("bun", [emulatorCli("s3"), "serve", "--port", String(s3Port), "--log", "off"]),
    start("bun", [
      emulatorCli("otel"),
      "serve",
      "--port",
      String(otelPort),
      "--ingest-auth",
      "none",
      "--log",
      "off",
    ]),
  ]
  const [pg, s3, otel] = processes as [Process, Process, Process]
  const stop = async () =>
    void (await Promise.all(processes.map((process) => process.stop("SIGKILL"))))
  try {
    await Promise.all([
      until(async () => pg.output().includes("listening"), "PostgreSQL emulator", pg),
      until(
        async () => (await fetch(`${s3Url}/${S3_BUCKET}`, { method: "PUT" })).ok,
        "S3 emulator",
        s3,
      ),
      until(async () => (await fetch(`${otelUrl}/__admin/health`)).ok, "OTLP emulator", otel),
    ])
  } catch (error) {
    // Never leave emulators running behind a stack that failed to come up.
    await stop()
    throw error
  }
  return { databaseUrl, s3Url, otelUrl, stop }
}

export type Server = Process & {
  /** Origin of the dashboard, API and fleets, e.g. http://localhost:41234 */
  url: string
  port: number
}

export type Stack = Emulators & {
  server: Server
  url: string
  /** The environment the server was started with. */
  env: Record<string, string>
  /** Start another replica of the server against the same database and bucket. */
  replica(env?: Record<string, string>): Promise<Server>
  /** Stop the server (SIGTERM, so it saves state) and start it again with the same settings. */
  restart(env?: Record<string, string>): Promise<Server>
  stop(): Promise<void>
}

/**
 * How the fleet server is run: the built bundle, which is exactly what the image ships
 * (default; global setup builds it), or from source with SPEC_SERVER=source.
 */
const serverCommand = () =>
  process.env.SPEC_SERVER === "source" ? ["src/main.ts"] : ["dist/main.js"]

/** The environment a server needs to use a set of emulators. Override or delete keys as needed. */
export function serverEnv(emulators: Emulators, port: number): Record<string, string> {
  return {
    PORT: String(port),
    PUBLIC_URL: `http://localhost:${port}`,
    AUTH_DEV_LOGIN: "1",
    // Every scenario signs its people in from 127.0.0.1; the per-address sign-in limit would
    // otherwise cut a worker off after 20 of them. Scenarios about that limit set it themselves.
    RATE_LIMIT_AUTH_PER_MINUTE: "0",
    OPERATOR_TOKEN,
    DATABASE_URL: emulators.databaseUrl,
    S3_ENDPOINT: emulators.s3Url,
    S3_REGION: "auto",
    S3_ACCESS_KEY_ID: "spec",
    S3_SECRET_ACCESS_KEY: "spec",
    S3_BUCKET,
    PUBLIC_DIR: join(PACKAGE_ROOT, "dist/public"),
  }
}

/** Run the server with an explicit environment, without waiting for it: for boot-failure specs. */
export const runServer = (env: Record<string, string>, args: string[] = []) =>
  start("bun", [...serverCommand(), ...args], env)

async function startServer(env: Record<string, string>): Promise<Server> {
  const process = runServer(env)
  const url = `http://localhost:${env.PORT}`
  try {
    await until(async () => (await fetch(`${url}/ready`)).ok, "fleet server", process)
  } catch (error) {
    await process.stop("SIGKILL")
    throw error
  }
  return Object.assign(process, { url, port: Number(env.PORT) })
}

/**
 * Start emulators and one fleet server on loopback. `overrides` are extra or replacement
 * environment variables for the server; a value of `""` removes the variable.
 */
export async function startStack(overrides: Record<string, string> = {}): Promise<Stack> {
  const emulators = await startEmulators()
  const servers: Server[] = []
  const build = async (extra: Record<string, string>) => {
    const env = { ...serverEnv(emulators, await freePort()), ...overrides, ...extra }
    for (const [key, value] of Object.entries(env)) if (value === "") delete env[key]
    const server = await startServer(env)
    servers.push(server)
    return { server, env }
  }
  const first = await build({}).catch(async (error) => {
    await emulators.stop()
    throw error
  })
  const stack: Stack = {
    ...emulators,
    server: first.server,
    url: first.server.url,
    env: first.env,
    replica: async (extra = {}) => (await build(extra)).server,
    async restart(extra = {}) {
      await stack.server.stop("SIGTERM")
      const env = { ...stack.env, ...extra }
      for (const [key, value] of Object.entries(env)) if (value === "") delete env[key]
      stack.server = await startServer(env)
      stack.env = env
      servers.push(stack.server)
      return stack.server
    },
    async stop() {
      await Promise.all(servers.map((server) => server.stop("SIGTERM")))
      await emulators.stop()
    },
  }
  return stack
}
