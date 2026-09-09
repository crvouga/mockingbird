import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import EmbeddedPostgres from "embedded-postgres"
import { RedisMemoryServer } from "redis-memory-server"
import { buildServerConfig, type MedplumServerConfig } from "./config.js"
import { ensureMedplumBuild } from "./ensure-medplum-build.js"
import { type MedplumPaths, resolveMedplumPaths } from "./paths.js"
import { findFreePort } from "./ports.js"

const HEALTHCHECK_PATH = "/healthcheck"
const SERVER_START_TIMEOUT_MS = 5 * 60 * 1000
const HEALTHCHECK_POLL_INTERVAL_MS = 500
const CHILD_STOP_GRACE_MS = 10000

export type MedplumProcessOptions = {
  version?: string | undefined
  cacheDir?: string | undefined
  onLog?: ((message: string) => void) | undefined
}

export type MedplumProcessInfo = {
  apiPort: number
  dbPort: number
  redisPort: number
  baseUrl: string
  dataDir: string
  paths: MedplumPaths
  config: MedplumServerConfig
}

const startEmbeddedPostgres = async (dataDir: string, port: number) => {
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
  })
  await pg.initialise()
  await pg.start()
  await pg.createDatabase("medplum")
  return pg
}

const resetMedplumDatabase = async (pg: EmbeddedPostgres): Promise<void> => {
  await pg.dropDatabase("medplum")
  await pg.createDatabase("medplum")
}

const healthcheckUrl = (baseUrl: string): string =>
  `${baseUrl.replace(/\/+$/, "")}${HEALTHCHECK_PATH}`

const pollHealthcheck = async (baseUrl: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = "unknown"
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthcheckUrl(baseUrl), { method: "GET" })
      if (response.ok) return
      lastError = `healthcheck responded with ${response.status}`
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTHCHECK_POLL_INTERVAL_MS))
  }
  throw new Error(
    `medplum server did not become healthy within ${timeoutMs}ms (last error: ${String(lastError)})`,
  )
}

export class MedplumServerProcess {
  private readonly options: MedplumProcessOptions
  private postgres: EmbeddedPostgres | undefined
  private redis: RedisMemoryServer | undefined
  private child: ChildProcess | undefined
  private runDir: string | undefined
  private started = false
  private starting: Promise<void> | undefined
  private boundApiPort: number | undefined
  private boundDbPort: number | undefined
  private boundRedisPort: number | undefined
  private exitGuard: (() => void) | undefined

  constructor(options: MedplumProcessOptions = {}) {
    this.options = options
  }

  get isStarted(): boolean {
    return this.started
  }

  get baseUrl(): string {
    const port = this.boundApiPort
    if (!this.started || port === undefined)
      throw new Error("medplum server is not started; call start() first")
    return `http://127.0.0.1:${port}/`
  }

  get apiPort(): number {
    const port = this.boundApiPort
    if (!this.started || port === undefined)
      throw new Error("medplum server is not started; call start() first")
    return port
  }

  get dbPort(): number {
    const port = this.boundDbPort
    if (!this.started || port === undefined)
      throw new Error("medplum server is not started; call start() first")
    return port
  }

  get redisPort(): number {
    const port = this.boundRedisPort
    if (!this.started || port === undefined)
      throw new Error("medplum server is not started; call start() first")
    return port
  }

  get info(): MedplumProcessInfo {
    const paths = resolveMedplumPaths({
      version: this.options.version,
      cacheDir: this.options.cacheDir,
    })
    const dataDir = this.runDir ?? ""
    const apiPort = this.apiPort
    const dbPort = this.dbPort
    const redisPort = this.redisPort
    return {
      apiPort,
      dbPort,
      redisPort,
      baseUrl: this.baseUrl,
      dataDir,
      paths,
      config: buildServerConfig({
        apiPort,
        dbPort,
        redisPort,
        dataDir,
      }),
    }
  }

  async start(): Promise<void> {
    if (this.started) return
    if (this.starting) return this.starting
    this.starting = this.boot()
    try {
      await this.starting
    } finally {
      this.starting = undefined
    }
  }

  private async boot(): Promise<void> {
    const dataDir = await mkdtemp(join(tmpdir(), "medplum-mock-"))
    this.runDir = dataDir
    const apiPort = await findFreePort()
    const dbPort = await findFreePort()
    const redisPort = await findFreePort()

    try {
      this.postgres = await startEmbeddedPostgres(dataDir, dbPort)
      this.redis = new RedisMemoryServer({
        instance: { port: redisPort, ip: "127.0.0.1" },
      })
      await this.redis.start()
      const resolvedRedisPort = await this.redis.getPort()

      const paths = await ensureMedplumBuild({
        version: this.options.version,
        cacheDir: this.options.cacheDir,
        onLog: this.options.onLog,
      })

      const config = buildServerConfig({
        apiPort,
        dbPort,
        redisPort: resolvedRedisPort,
        dataDir,
      })
      await writeFile(join(dataDir, "medplum.config.json"), JSON.stringify(config, null, 2))

      this.child = this.spawnServerProcess(paths, dataDir)
      this.boundApiPort = apiPort
      this.boundDbPort = dbPort
      this.boundRedisPort = resolvedRedisPort
      await pollHealthcheck(`http://127.0.0.1:${apiPort}/`, SERVER_START_TIMEOUT_MS)
      this.started = true
      this.registerExitGuard()
      this.options.onLog?.(`[medplum-mock] medplum server healthy at ${this.baseUrl}`)
    } catch (error) {
      await this.teardown()
      throw error
    }
  }

  private spawnServerProcess(paths: MedplumPaths, dataDir: string): ChildProcess {
    const child = spawn(process.execPath, [paths.serverEntry, "file:medplum.config.json"], {
      cwd: dataDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    child.stdout?.on("data", (chunk: Buffer) =>
      this.options.onLog?.(`[medplum-server] ${chunk.toString().trimEnd()}`),
    )
    child.stderr?.on("data", (chunk: Buffer) =>
      this.options.onLog?.(`[medplum-server] ${chunk.toString().trimEnd()}`),
    )
    child.on("exit", (code, signal) => {
      if (this.started && this.child === child) {
        this.options.onLog?.(
          `[medplum-mock] medplum server exited unexpectedly (code=${code} signal=${signal})`,
        )
      }
    })
    return child
  }

  /**
   * Stop the server, drop and recreate the medplum database (the server re-runs
   * migrations and seeding on boot, restoring pristine state), and boot it again.
   */
  async reset(): Promise<void> {
    if (!this.started || this.postgres === undefined) {
      throw new Error("medplum server is not started; call start() first")
    }
    const postgres = this.postgres
    await this.stopServerProcess()
    await resetMedplumDatabase(postgres)
    const paths = resolveMedplumPaths({
      version: this.options.version,
      cacheDir: this.options.cacheDir,
    })
    const dataDir = this.runDir ?? ""
    this.child = this.spawnServerProcess(paths, dataDir)
    await pollHealthcheck(this.baseUrl, SERVER_START_TIMEOUT_MS)
  }

  async stop(): Promise<void> {
    if (!this.started) return
    await this.teardown()
  }

  private async stopServerProcess(): Promise<void> {
    const child = this.child
    if (!child || child.exitCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL")
        resolve()
      }, CHILD_STOP_GRACE_MS)
      child.once("exit", () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill("SIGTERM")
    })
    this.child = undefined
  }

  private async teardown(): Promise<void> {
    this.unregisterExitGuard()
    await this.stopServerProcess()
    if (this.redis) {
      try {
        await this.redis.stop()
      } catch {
        // already stopped
      }
      this.redis = undefined
    }
    if (this.postgres) {
      try {
        await this.postgres.stop()
      } catch {
        // already stopped
      }
      this.postgres = undefined
    }
    if (this.runDir && existsSync(this.runDir)) {
      rmSync(this.runDir, { recursive: true, force: true })
    }
    this.runDir = undefined
    this.boundApiPort = undefined
    this.boundDbPort = undefined
    this.boundRedisPort = undefined
    this.started = false
  }

  private registerExitGuard(): void {
    if (this.exitGuard) return
    this.exitGuard = () => {
      this.child?.kill("SIGKILL")
      try {
        void this.postgres?.stop()
      } catch {
        // process is exiting
      }
      void this.redis?.stop()
    }
    const host = process as unknown as {
      on(event: string, listener: () => void): unknown
      off(event: string, listener: () => void): unknown
    }
    host.on("exit", this.exitGuard)
    host.on("SIGINT", this.exitGuard)
    host.on("SIGTERM", this.exitGuard)
  }

  private unregisterExitGuard(): void {
    if (!this.exitGuard) return
    const host = process as unknown as {
      on(event: string, listener: () => void): unknown
      off(event: string, listener: () => void): unknown
    }
    host.off("exit", this.exitGuard)
    host.off("SIGINT", this.exitGuard)
    host.off("SIGTERM", this.exitGuard)
    this.exitGuard = undefined
  }
}
