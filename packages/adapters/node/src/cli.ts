import { readFile } from "node:fs/promises"
import { type ParseArgsConfig, parseArgs } from "node:util"
import type { RequestLog, ServiceInstance, ServiceRuntime } from "@crvouga/mockingbird-service"
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
  adminKey: string | undefined
  seed: string | undefined
  onLog: ((entry: RequestLog) => void) | undefined
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
}

const COMMON_SERVE_OPTIONS: Record<string, CliOption> = {
  port: { type: "string", value: "<port>", description: "Port to listen on" },
  host: { type: "string", value: "<host>", description: "Interface to bind", default: "127.0.0.1" },
  "admin-key": {
    type: "string",
    value: "<key>",
    description: "Require x-mockingbird-admin-key on /__admin/* (env MOCKINGBIRD_ADMIN_KEY)",
  },
  seed: { type: "string", value: "<seed>", description: "Seed for every random choice" },
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
}

const formatLog = (format: LogFormat) => {
  if (format === "off") return undefined
  if (format === "json") return (entry: RequestLog) => console.log(JSON.stringify(entry))
  return (entry: RequestLog) => {
    const op = entry.operationId ?? (entry.unmatched ? "UNMATCHED" : "-")
    const ns = entry.namespace === "default" ? "" : ` [${entry.namespace}]`
    const fault = entry.faultId ? ` fault=${entry.faultId}` : ""
    const adopted = entry.adopted ? " adopted" : ""
    console.log(
      `${entry.service} ${entry.method} ${entry.path} ${entry.status} ${op} ${entry.durationMs}ms${ns}${fault}${adopted}`,
    )
  }
}

const asString = (value: string | boolean | undefined): string | undefined =>
  typeof value === "string" ? value : undefined

/** A service entry in `mockingbird.json`. */
export type ConfigService = {
  port?: number
  host?: string
  adminKey?: string
  seed?: string
  /** Service-specific serve flags, by long name: `{ "webhook-url": "…" }`. */
  options?: Record<string, string | boolean>
}

export type MockingbirdConfig = {
  /** Keyed by service name: `junction` loads `@crvouga/mockingbird-service-junction`. */
  services: Record<string, ConfigService>
  log?: LogFormat
}

const loadTarget = async (name: string, own: ServeTarget): Promise<ServeTarget> => {
  if (name === own.name) return own
  const specifier = `@crvouga/mockingbird-service-${name}/server`
  try {
    const mod = (await import(specifier)) as { serveTarget?: ServeTarget }
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
  config: { port: number; host: string; adminKey?: string; seed?: string; log: LogFormat },
): Promise<Listening> => {
  const runtime = await target.create(values, {
    adminKey: config.adminKey,
    seed: config.seed,
    onLog: formatLog(config.log),
  })
  const listening = await listen(runtime, { port: config.port, host: config.host })
  console.log(`${target.name} mock listening on ${listening.url}`)
  console.log(`${target.name} health: GET ${listening.url}/health`)
  console.log(
    `${target.name} admin: ${listening.url}/__admin (${config.adminKey ? "x-mockingbird-admin-key required" : "open — pass --admin-key to lock"})`,
  )
  for (const line of target.banner?.(runtime) ?? []) console.log(`${target.name} ${line}`)
  return listening
}

const untilSignal = async (servers: Listening[]): Promise<number> =>
  new Promise((resolve) => {
    const stop = async () => {
      await Promise.allSettled(servers.map((s) => s.close()))
      resolve(0)
    }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  })

/** The standard `serve` command for a service, including multi-service `--config`. */
export const serveCommand = (target: ServeTarget): CliCommand => ({
  summary: `Serve the ${target.name} mock over HTTP`,
  options: { ...COMMON_SERVE_OPTIONS, ...target.options },
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
      const config = JSON.parse(await readFile(configPath, "utf8")) as MockingbirdConfig
      const servers: Listening[] = []
      try {
        for (const [name, entry] of Object.entries(config.services ?? {})) {
          const each = await loadTarget(name, target)
          servers.push(
            await start(each, entry.options ?? {}, {
              port: entry.port ?? each.defaultPort,
              host: entry.host ?? "127.0.0.1",
              ...(entry.adminKey !== undefined ? { adminKey: entry.adminKey } : {}),
              ...(entry.seed !== undefined ? { seed: entry.seed } : {}),
              log: config.log ?? log,
            }),
          )
        }
      } catch (error) {
        await Promise.allSettled(servers.map((s) => s.close()))
        console.error(error instanceof Error ? error.message : String(error))
        return 1
      }
      return untilSignal(servers)
    }
    const port = asString(values.port)
    const adminKey = asString(values["admin-key"]) ?? process.env.MOCKINGBIRD_ADMIN_KEY
    const seed = asString(values.seed)
    let listening: Listening
    try {
      listening = await start(target, values, {
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
