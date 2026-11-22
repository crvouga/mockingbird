import { join, normalize } from "node:path"
import { createApp } from "./app.js"
import { createAuth } from "./auth.js"
import {
  type Config,
  formatProblems,
  loadConfig,
  type Problem,
  StartupError,
  withVaultSecrets,
} from "./config.js"
import { Engine } from "./engine.js"
import { UsageMeter } from "./limits.js"
import { memoryObjectStore, s3ObjectStore } from "./objects.js"
import { preflight } from "./preflight.js"
import { memoryDatabase } from "./store/memory.js"
import { postgresDatabase } from "./store/postgres.js"
import { createTelemetry } from "./telemetry.js"

/** `bun dist/main.js check` validates configuration and dependencies, then exits. */
const checkOnly = process.argv[2] === "check"
/** sysexits.h EX_CONFIG: the process is fine, its configuration is not. */
const EXIT_CONFIG = 78

/**
 * Fail fast and loud: a numbered, plain-language report on stderr for whoever reads the log,
 * followed by the same problems as one JSON line for tools. Never a stack trace, never a secret.
 */
function fatal(problems: Problem[]): never {
  console.error(formatProblems(problems))
  console.error(JSON.stringify({ level: "fatal", event: "startup_failed", problems }))
  process.exit(EXIT_CONFIG)
}
const unexpected = (stage: string, error: unknown): never =>
  fatal([
    {
      code: "unexpected_startup_error",
      what: `Startup failed while ${stage}`,
      why: error instanceof Error ? (error.stack ?? error.message) : String(error),
      fix: "This is not a known configuration problem. Report it with this output at https://github.com/crvouga/mockingbird/issues.",
      env: [],
    },
  ])

let config: Config
try {
  config = loadConfig(await withVaultSecrets(process.env))
} catch (error) {
  if (error instanceof StartupError) fatal(error.problems)
  throw unexpected("reading configuration", error)
}

const telemetry = createTelemetry({
  endpoint: config.otel?.endpoint,
  headers: config.otel?.headers ?? {},
  serviceName: config.otel?.serviceName ?? "mockingbird-fleet",
})
const db = config.databaseUrl
  ? postgresDatabase(config.databaseUrl, config.databaseSchema)
  : memoryDatabase()
const objects = config.s3
  ? s3ObjectStore({ ...config.s3, prefix: config.s3Prefix })
  : memoryObjectStore()

// Prove the database and the object store work with these credentials before listening. A
// misconfigured deploy must fail its health check, not pass it and then fail every request.
const problems = await preflight(db, objects, config).catch((error) =>
  unexpected("checking the database and object store", error),
)
if (problems.length > 0) fatal(problems)

const summary = {
  public_url: config.publicUrl,
  fleet_url: config.fleetUrl,
  database: config.databaseUrl ? `postgres (schema ${config.databaseSchema})` : "memory",
  object_store: config.s3 ? `s3 (${config.s3.bucket}/${config.s3Prefix})` : "memory",
  sign_in: [
    config.oidc && "oidc",
    config.operatorTokenHash && "operator-issued tokens",
    config.devLogin && "dev login",
  ].filter(Boolean),
  telemetry: config.otel ? "otlp" : "stdout",
}
if (checkOnly) {
  console.log("mockingbird-fleet configuration is valid; the database and object store work.")
  console.log(JSON.stringify({ level: "info", event: "check_passed", ...summary }))
  await db.close()
  process.exit(0)
}

const engine = new Engine({
  objects,
  telemetry,
  maxInstances: config.maxInstances,
  idleMs: config.instanceIdleMs,
})
const meter = new UsageMeter(db)
const app = createApp({
  db,
  engine,
  auth: createAuth({ db, config }),
  config,
  telemetry,
  meter,
  asset: async (path) => {
    const root = process.env.PUBLIC_DIR ?? join(import.meta.dir, "public")
    const file = Bun.file(join(root, normalize(`/${path}`)))
    if (!(await file.exists())) return undefined
    return new Response(file, { headers: { "cache-control": "no-cache" } })
  },
})

let server: ReturnType<typeof Bun.serve>
try {
  server = Bun.serve({
    port: config.port,
    hostname: "0.0.0.0",
    maxRequestBodySize: 32 * 1024 * 1024,
    idleTimeout: 120,
    fetch: (request, self) => app.fetch(request, self.requestIP(request)?.address),
  })
} catch (error) {
  fatal([
    {
      code: "port_unavailable",
      what: `Could not listen on port ${config.port}`,
      why: error instanceof Error ? error.message : String(error),
      fix: "Another process is using the port, or it is below 1024 and the process is not root. Choose a free port.",
      env: ["PORT=8080"],
    },
  ])
}

telemetry.log("info", "listening", {
  port: config.port,
  ...summary,
  sign_in: summary.sign_in.join(", "),
})
if (!config.databaseUrl || !config.s3)
  telemetry.log("warn", "running with in-memory storage: nothing survives a restart")
if (
  config.trustedProxyHops === 0 &&
  !["localhost", "127.0.0.1"].includes(new URL(config.publicUrl).hostname)
)
  telemetry.log(
    "warn",
    "TRUSTED_PROXY_HOPS is 0: if this server is behind a reverse proxy or load balancer, every client shares the proxy's address and per-address rate limits apply to all of them together. Set TRUSTED_PROXY_HOPS to the number of proxies in front of it (usually 1).",
  )

process.on("unhandledRejection", (reason) =>
  telemetry.log("error", "unhandled rejection", {
    error: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
  }),
)

let stopping = false
const stop = async (signal: string) => {
  if (stopping) return
  stopping = true
  telemetry.log("info", "shutting down", { signal })
  // Stop taking requests, let in-flight ones finish, then save every emulator's unsaved state.
  await server.stop()
  await engine.close()
  await meter.close()
  await telemetry.close()
  await db.close()
  process.exit(0)
}
process.on("SIGTERM", () => void stop("SIGTERM"))
process.on("SIGINT", () => void stop("SIGINT"))
