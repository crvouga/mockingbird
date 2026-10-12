import type { EventEmitter } from "node:events"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { type ParseArgsConfig, parseArgs } from "node:util"
import type {
  MockControls,
  RequestLog,
  ServiceInstance,
  ServiceRuntime,
} from "@crvouga/mockingbird-service"
import {
  normalizeBootControls,
  parseFaultHeader,
  resolveAdminPrefix,
} from "@crvouga/mockingbird-service"
import { type FleetTarget, startFleet } from "./fleet.js"
import { type Listening, listen } from "./listen.js"

export type CliOption = {
  type: "string" | "boolean"
  description: string
  /** Shown in help; the value placeholder, e.g. `<port>`. */
  value?: string
  default?: string | boolean
}

export type CliValues = Record<string, string | boolean | undefined>

export type CliCommand = {
  summary: string
  usage?: string
  options?: Record<string, CliOption>
  /** Resolves to an exit code; a server command resolves only when it stops. */
  run(values: CliValues, positionals: string[]): Promise<number>
}

export type CliSpec = {
  bin: string
  description: string
  commands: Record<string, CliCommand>
}

const optionHelp = (options: Record<string, CliOption>): string[] =>
  Object.entries(options).map(([name, option]) => {
    const flag = `--${name}${option.type === "string" ? ` ${option.value ?? "<value>"}` : ""}`
    const fallback = option.default !== undefined ? ` (default: ${String(option.default)})` : ""
    return `  ${flag.padEnd(30)} ${option.description}${fallback}`
  })

const help = (spec: CliSpec): string =>
  [
    `${spec.bin} — ${spec.description}`,
    "",
    "Usage:",
    `  ${spec.bin} <command> [options]`,
    "",
    "Commands:",
    ...Object.entries(spec.commands).map(([name, c]) => `  ${name.padEnd(30)} ${c.summary}`),
    "",
    `Run \`${spec.bin} <command> --help\` for a command's options.`,
  ].join("\n")

const commandHelp = (spec: CliSpec, name: string, command: CliCommand): string =>
  [
    `${spec.bin} ${name} — ${command.summary}`,
    "",
    "Usage:",
    `  ${command.usage ?? `${spec.bin} ${name} [options]`}`,
    ...(command.options ? ["", "Options:", ...optionHelp(command.options)] : []),
  ].join("\n")

/** Parse `argv` against `spec` and run the chosen command. Resolves to an exit code. */
export const runCli = async (spec: CliSpec, argv: string[]): Promise<number> => {
  // Two-word commands (`corpus pull`) win over one-word ones.
  const pair = argv.length >= 2 ? `${argv[0]} ${argv[1]}` : undefined
  const words = pair !== undefined && spec.commands[pair] ? 2 : 1
  const name = words === 2 ? pair : argv[0]
  const rest = argv.slice(words)
  if (name === undefined || name === "--help" || name === "-h" || name === "help") {
    console.log(help(spec))
    return 0
  }
  const command = spec.commands[name]
  if (!command) {
    console.error(`${spec.bin}: unknown command ${JSON.stringify(name)}\n\n${help(spec)}`)
    return 2
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(commandHelp(spec, name, command))
    return 0
  }
  let parsed: { values: CliValues; positionals: string[] }
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: Object.fromEntries(
        Object.entries(command.options ?? {}).map(([key, option]) => [
          key,
          {
            type: option.type,
            ...(option.default !== undefined ? { default: option.default } : {}),
          },
        ]),
      ) as ParseArgsConfig["options"],
    }) as { values: CliValues; positionals: string[] }
  } catch (error) {
    console.error(
      `${spec.bin} ${name}: ${error instanceof Error ? error.message : String(error)}\n\n${commandHelp(spec, name, command)}`,
    )
    return 2
  }
  return command.run(parsed.values, parsed.positionals)
}

// ── serve ──────────────────────────────────────────────────────────

export type LogFormat = "pretty" | "json" | "off"

export type CommonServeOptions = {
  adminPrefix?: string
  adminKey: string | undefined
  seed: string | undefined
  onLog: ((entry: RequestLog) => void) | undefined
  /** Admin controls to boot with: clock, latency, faults, a starting snapshot. */
  adminControls?: MockControls
  /** Synthetic provider fixture objects supplied by a fleet entry. */
  fixtures?: Record<string, unknown>
  baseUrl?: string
}

/**
 * What a service contributes to `serve`: how to build its runtime from CLI flags,
 * and what to say at startup. Every service's `./server` entry exports one as
 * `serveTarget`, which is also how `serve --config` finds services by name.
 */
export type ServeTarget = {
  name: string
  defaultPort: number
  /** Serve flags beyond the common ones. */
  options?: Record<string, CliOption>
  create(
    values: CliValues,
    common: CommonServeOptions,
  ): Promise<ServiceRuntime<ServiceInstance>> | ServiceRuntime<ServiceInstance>
  /** Startup lines after the listen address, e.g. the loaded corpus version. */
  banner?(runtime: ServiceRuntime<ServiceInstance>): string[]
  /** After the HTTP server is bound. A service that speaks more than HTTP attaches it here. */
  listening?(server: Listening): void
}

const COMMON_SERVE_OPTIONS: Record<string, CliOption> = {
  port: { type: "string", value: "<port>", description: "Port to listen on" },
  host: { type: "string", value: "<host>", description: "Interface to bind", default: "127.0.0.1" },
  "admin-prefix": {
    type: "string",
    value: "<path>",
    description: "Internal API prefix (default /__admin; env MOCKINGBIRD_ADMIN_PREFIX)",
  },
  "admin-key": {
    type: "string",
    value: "<key>",
    description: "Require x-mockingbird-admin-key on /__admin/* (env MOCKINGBIRD_ADMIN_KEY)",
  },
  seed: {
    type: "string",
    value: "<seed>",
    description: "Seed for every random choice (env MOCKINGBIRD_SEED)",
  },
  "admin-controls": {
    type: "string",
    value: "<json|file>",
    description:
      "Admin controls to boot with, as JSON or a JSON file: clock, latency, faults, snapshot, namespaces (env MOCKINGBIRD_ADMIN_CONTROLS)",
  },
  clock: {
    type: "string",
    value: "<instant>",
    description: "Start the clock at this instant (epoch ms or ISO-8601)",
  },
  freeze: { type: "boolean", description: "Freeze the clock: it moves only when told to" },
  "auto-advance": {
    type: "string",
    value: "<duration>",
    description: "Step the clock this much before every request (e.g. 1s)",
  },
  latency: {
    type: "string",
    value: "<duration>",
    description: "Baseline response time for every request (e.g. 250ms)",
  },
  jitter: {
    type: "string",
    value: "<duration>",
    description: "Seeded extra latency between 0 and this",
  },
  "virtual-time": {
    type: "boolean",
    description: "Spend latency, delays and timeouts on the mock clock instead of really waiting",
  },
  fault: {
    type: "string",
    value: "<fault>",
    description:
      'A fault to boot with, as in x-mockingbird-fault: 503, rate_limited, "status=503; delay=2s"',
  },
  snapshot: {
    type: "string",
    value: "<file>",
    description: "Start from a snapshot document (GET /__admin/snapshots/:id)",
  },
  log: {
    type: "string",
    value: "<pretty|json|off>",
    description: "Request log format",
    default: "pretty",
  },
  "log-requests": {
    type: "boolean",
    description:
      "One JSON line per request: namespace, operationId, status, ids touched (never bodies). Same as --log json",
  },
  config: {
    type: "string",
    value: "<file>",
    description: "Serve every service in a mockingbird.json config instead",
  },
  "ready-file": {
    type: "string",
    description: "Atomically publish fleet endpoint JSON",
    value: "<file>",
  },
  "connections-file": {
    type: "string",
    description: "Write private connection URLs with mode 0600",
    value: "<file>",
  },
  "ready-json": {
    type: "boolean",
    description: "Emit one public JSON record after fleet readiness",
  },
}

const formatLog = (format: LogFormat) => {
  if (format === "off") return undefined
  if (format === "json") return (entry: RequestLog) => console.log(JSON.stringify(entry))
  return (entry: RequestLog) => {
    const op = entry.operationId ?? (entry.unmatched ? "UNMATCHED" : "-")
    const ns = entry.namespace === "default" ? "" : ` [${entry.namespace}]`
    const fault = entry.faultId ? ` fault=${entry.faultId}` : ""
    const adopted = entry.adopted ? " adopted" : ""
    // A rejection says what arrived (never the body) and why the service refused it.
    const received = entry.request
      ? ` received=${entry.request.bodyBytes === null ? "?" : `${entry.request.bodyBytes}B`} ct=${entry.request.contentType ?? "-"}${
          entry.request.transferEncoding ? ` te=${entry.request.transferEncoding}` : ""
        }`
      : ""
    const issues = entry.issues?.length
      ? ` issues=${entry.issues
          .slice(0, 3)
          .map((issue) => `${issue.path || "$"}: ${issue.message}`)
          .join("; ")}${entry.issues.length > 3 ? ` (+${entry.issues.length - 3})` : ""}`
      : ""
    console.log(
      `${entry.service} ${entry.method} ${entry.path} ${entry.status} ${op} ${entry.durationMs}ms${ns}${fault}${adopted}${received}${issues}`,
    )
  }
}

const asString = (value: string | boolean | undefined): string | undefined =>
  typeof value === "string" ? value : undefined

const readJsonFile = async (path: string, label: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown
  } catch (error) {
    throw new Error(
      `${label}: cannot read ${path}: ${error instanceof Error ? error.message : error}`,
    )
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The boot controls a `serve` invocation asks for: `--admin-controls` (or `MOCKINGBIRD_ADMIN_CONTROLS`) as
 * the base document, with the single-purpose flags on top. Checked here, so a bad value stops
 * the command before a port is bound. `undefined` when nothing was asked for.
 */
export const resolveServeControls = async (
  values: CliValues,
  env: Record<string, string | undefined> = process.env,
  base?: unknown,
): Promise<MockControls | undefined> => {
  const source = asString(values["admin-controls"]) ?? env.MOCKINGBIRD_ADMIN_CONTROLS
  let document: Record<string, unknown> = isObject(base) ? { ...base } : {}
  if (source !== undefined && source.trim() !== "") {
    let parsed: unknown
    if (source.trim().startsWith("{")) {
      try {
        parsed = JSON.parse(source)
      } catch {
        throw new Error("--admin-controls: not valid JSON")
      }
    } else parsed = await readJsonFile(source, "--admin-controls")
    if (!isObject(parsed)) throw new Error("--admin-controls: expected a JSON object")
    document = { ...document, ...parsed }
  }
  const clock: Record<string, unknown> = isObject(document.clock) ? { ...document.clock } : {}
  const now = asString(values.clock)
  if (now !== undefined) clock.now = now
  if (values.freeze === true) clock.frozen = true
  const autoAdvance = asString(values["auto-advance"])
  if (autoAdvance !== undefined) clock.autoAdvance = autoAdvance
  if (Object.keys(clock).length > 0) document.clock = clock
  const delay = asString(values.latency)
  const jitter = asString(values.jitter)
  if (delay !== undefined || jitter !== undefined) {
    const latency: Record<string, unknown> = isObject(document.latency)
      ? { ...document.latency }
      : document.latency !== undefined
        ? { delay: document.latency }
        : {}
    if (delay !== undefined) latency.delay = delay
    if (jitter !== undefined) latency.jitter = jitter
    document.latency = latency
  }
  if (values["virtual-time"] === true) document.virtualTime = true
  const fault = asString(values.fault)
  if (fault !== undefined)
    document.faults = [
      ...(Array.isArray(document.faults) ? document.faults : []),
      parseFaultHeader(fault, "--fault"),
    ]
  const snapshot = asString(values.snapshot)
  if (snapshot !== undefined) document.snapshot = await readJsonFile(snapshot, "--snapshot")
  if (Object.keys(document).length === 0) return undefined
  normalizeBootControls(document, "adminControls")
  return document as MockControls
}

/** A service entry in `mockingbird.json`. */
export type ConfigService = {
  protocol?: "http" | "postgres" | "redis"
  port?: number
  host?: string
  adminPrefix?: string
  adminKey?: string
  seed?: string
  /** Admin controls this service boots with. A key given here replaces the fleet-wide one. */
  adminControls?: MockControls
  fixtures?: Record<string, unknown>
  baseUrl?: string
  password?: string
  user?: string
  database?: string
  /** Protocol namespace selectors: database names for Postgres, logical DB indexes for Redis. */
  namespaces?: Record<string, string | number>
  /** Service-specific serve flags, by long name: `{ "webhook-url": "…" }`. */
  options?: Record<string, string | boolean>
}

export type MockingbirdConfig = {
  /** Keyed by service name: `junction` loads `@crvouga/mockingbird-service-junction`. */
  services: Record<string, ConfigService>
  log?: LogFormat
  adminPrefix?: string
  adminKey?: string
  /** Admin controls every HTTP service in the fleet boots with. */
  adminControls?: MockControls
  namespace?: string
  control?: { host?: string; port?: number }
}

const loadTarget = async (name: string, own: FleetTarget): Promise<FleetTarget> => {
  if (name === own.name) return own
  const specifier = `@crvouga/mockingbird-service-${name}/server`
  try {
    // A CLI run with npx may live outside the consumer project. Discover its locally
    // installed services as well as siblings of the bundled CLI.
    let mod: { serveTarget?: FleetTarget }
    try {
      mod = (await import(specifier)) as { serveTarget?: FleetTarget }
    } catch {
      const fromProject = createRequire(resolve(process.cwd(), "package.json"))
      mod = (await import(pathToFileURL(fromProject.resolve(specifier)).href)) as {
        serveTarget?: FleetTarget
      }
    }
    if (!mod.serveTarget) throw new Error(`${specifier} exports no serveTarget`)
    return mod.serveTarget
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `cannot load service "${name}": ${reason}. Install @crvouga/mockingbird-service-${name}.`,
    )
  }
}

const start = async (
  target: ServeTarget,
  values: CliValues,
  config: {
    port: number
    host: string
    adminPrefix?: string
    adminKey?: string
    seed?: string
    adminControls?: MockControls
    log: LogFormat
  },
): Promise<Listening> => {
  const adminPrefix = resolveAdminPrefix(config.adminPrefix)
  const runtime = await target.create(values, {
    adminPrefix,
    adminKey: config.adminKey,
    seed: config.seed,
    onLog: formatLog(config.log),
    ...(config.adminControls !== undefined ? { adminControls: config.adminControls } : {}),
  })
  const listening = await listen(runtime, { port: config.port, host: config.host })
  target.listening?.(listening)
  console.log(`${target.name} emulator listening on ${listening.url}`)
  console.log(`${target.name} health: GET ${listening.url}${adminPrefix}/health`)
  console.log(
    `${target.name} admin: ${listening.url}${adminPrefix} (${config.adminKey ? "x-mockingbird-admin-key required" : "open — pass --admin-key to lock"})`,
  )
  console.log(`${target.name} admin ui: ${listening.url}${adminPrefix}/ui`)
  for (const line of target.banner?.(runtime) ?? [])
    console.log(`${target.name} ${line.replaceAll("/__admin", adminPrefix)}`)
  return listening
}

const untilSignal = async (servers: { close(): Promise<void> }[]): Promise<number> =>
  new Promise((resolve) => {
    const stop = async () => {
      ;(process as EventEmitter).removeListener("SIGINT", stop)
      ;(process as EventEmitter).removeListener("SIGTERM", stop)
      await Promise.allSettled(servers.map((s) => s.close()))
      resolve(0)
    }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  })

/** The standard `serve` command for a service, including multi-service `--config`. */
export const serveCommand = (target: FleetTarget): CliCommand => ({
  summary: `Serve the ${target.name} emulator or a configured fleet`,
  options: { ...COMMON_SERVE_OPTIONS, ...("options" in target ? target.options : {}) },
  async run(values) {
    const log = (
      values["log-requests"] === true ? "json" : (asString(values.log) ?? "pretty")
    ) as LogFormat
    if (!["pretty", "json", "off"].includes(log)) {
      console.error(`--log must be pretty, json or off (got ${log})`)
      return 2
    }
    const configPath = asString(values.config)
    if (configPath !== undefined) {
      try {
        const config = JSON.parse(await readFile(configPath, "utf8")) as MockingbirdConfig
        config.adminPrefix = resolveAdminPrefix(
          config.adminPrefix ??
            asString(values["admin-prefix"]) ??
            process.env.MOCKINGBIRD_ADMIN_PREFIX,
        )
        const adminKey =
          config.adminKey ?? asString(values["admin-key"]) ?? process.env.MOCKINGBIRD_ADMIN_KEY
        if (adminKey !== undefined) config.adminKey = adminKey
        // Flags and MOCKINGBIRD_ADMIN_CONTROLS apply on top of the config file's own controls.
        const adminControls = await resolveServeControls(values, process.env, config.adminControls)
        if (adminControls !== undefined) config.adminControls = adminControls
        const fleet = await startFleet(config, {
          load: (name) => loadTarget(name, target),
          onLog: formatLog(config.log ?? log),
          ...(asString(values["ready-file"]) ? { readyFile: asString(values["ready-file"]) } : {}),
          ...(asString(values["connections-file"])
            ? { connectionsFile: asString(values["connections-file"]) }
            : {}),
          onReady: (manifest) => {
            if (values["ready-json"]) console.log(JSON.stringify(manifest))
            else
              for (const [name, endpoint] of Object.entries(manifest.services))
                console.log(`${name} emulator listening on ${endpoint.url}`)
          },
        })
        return untilSignal([fleet])
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        return 1
      }
    }
    if ("start" in target) {
      console.error("Use --config to supervise protocol services with this command")
      return 2
    }
    const port = asString(values.port)
    const adminKey = asString(values["admin-key"]) ?? process.env.MOCKINGBIRD_ADMIN_KEY
    const seed = asString(values.seed) ?? process.env.MOCKINGBIRD_SEED
    let listening: Listening
    try {
      const adminControls = await resolveServeControls(values)
      listening = await start(target, values, {
        ...(adminControls !== undefined ? { adminControls } : {}),
        adminPrefix: resolveAdminPrefix(
          asString(values["admin-prefix"]) ?? process.env.MOCKINGBIRD_ADMIN_PREFIX,
        ),
        port: port === undefined ? target.defaultPort : Number.parseInt(port, 10),
        host: asString(values.host) ?? "127.0.0.1",
        ...(adminKey !== undefined ? { adminKey } : {}),
        ...(seed !== undefined ? { seed } : {}),
        log,
      })
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      return 1
    }
    return untilSignal([listening])
  },
})
