import { readFile, realpath } from "node:fs/promises"
import { createRequire } from "node:module"
import { basename, dirname, resolve } from "node:path"
import { normalizeBootControls, resolveAdminPrefix } from "@crvouga/mockingbird-service"
import type { MockingbirdConfig } from "./cli.js"
import type { FleetOptions, FleetTarget } from "./fleet.js"
import { validateCompatibilityTags } from "./fleet-archive.js"
import { advertisedHttpBase, supportsPublicIngress } from "./fleet-proxy.js"
import { assertFleetConfig } from "./fleet-schema.js"

const destination = async (path: string): Promise<string> => {
  const absolute = resolve(path)
  try {
    return await realpath(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    const parent = dirname(absolute)
    return parent === absolute ? absolute : resolve(await destination(parent), basename(absolute))
  }
}

/** Read-only validation/load phase. No target starts until every entry passes. */
export async function preflightFleet(config: MockingbirdConfig, options: FleetOptions) {
  if (
    options.readyFile &&
    options.connectionsFile &&
    (await destination(options.readyFile)) === (await destination(options.connectionsFile))
  )
    throw new Error("ready-file and connections-file destinations must differ")
  if (
    !config.services ||
    typeof config.services !== "object" ||
    (!Object.keys(config.services).length && !Object.keys(options.participants ?? {}).length)
  )
    throw new Error("config must contain at least one service")
  validateFleetPolicies(options)
  if (
    options.archiveProtection &&
    options.repository &&
    options.repository.protectionPolicy?.format !== options.archiveProtection.policy.format
  )
    throw new Error(
      "protected archive policy requires a protected repository; configure its protector before startup",
    )
  resolveAdminPrefix(config.adminPrefix)
  normalizeBootControls(config.adminControls)
  const targets = new Map<string, FleetTarget>()
  const ports = new Set<string>()
  for (const [name, entry] of Object.entries(config.services)) {
    try {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("invalid service name")
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        throw new Error("expected service object")
      resolveAdminPrefix(entry.adminPrefix ?? config.adminPrefix)
      normalizeBootControls(
        { ...config.adminControls, ...entry.adminControls },
        `services.${name}.adminControls`,
      )
      if (
        entry.port !== undefined &&
        (!Number.isInteger(entry.port) || entry.port < 0 || entry.port > 65535)
      )
        throw new Error("invalid port")
      if (entry.target !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.target))
        throw new Error("target must name a supported service suffix")
      const service = entry.target ?? name
      if (advertisedHttpBase(entry) && !supportsPublicIngress(service))
        throw new Error(
          `public ingress unsupported for ${service}; use a direct endpoint to preserve signed targets`,
        )
      const target = await options.load(service)
      const protocol = "protocol" in target ? target.protocol : "http"
      if (entry.protocol !== undefined && entry.protocol !== protocol)
        throw new Error("configured protocol does not match target")
      if (protocol !== "http") {
        if (
          entry.seed !== undefined &&
          (!String(entry.seed).trim() || !Number.isFinite(Number(entry.seed)))
        )
          throw new Error("protocol seed must be a finite number")
        for (const [namespace, selector] of Object.entries(entry.namespaces ?? {})) {
          if (!/^[A-Za-z0-9_.-]{1,64}$/.test(namespace)) throw new Error("invalid namespace")
          if (
            protocol === "postgres"
              ? typeof selector !== "string" || !selector.length
              : typeof selector !== "number" ||
                !Number.isInteger(selector) ||
                selector < 0 ||
                selector > 15
          )
            throw new Error("invalid protocol namespace selector")
        }
      }
      const port = entry.port ?? target.defaultPort
      if (port !== 0) {
        const key = `${entry.host ?? "127.0.0.1"}:${port}`
        if (ports.has(key)) throw new Error(`duplicate listener ${key}`)
        ports.add(key)
      }
      let packageVersion = target.packageVersion
      if (!packageVersion) {
        for (const from of [
          createRequire(resolve(process.cwd(), "package.json")),
          createRequire(import.meta.url),
        ]) {
          try {
            let directory = dirname(from.resolve(`@crvouga/mockingbird-service-${service}/server`))
            for (;;) {
              try {
                const manifest = JSON.parse(
                  await readFile(resolve(directory, "package.json"), "utf8"),
                ) as { name?: string; version?: string }
                if (manifest.name === `@crvouga/mockingbird-service-${service}`) {
                  packageVersion = manifest.version
                  break
                }
              } catch {}
              const parent = dirname(directory)
              if (parent === directory) break
              directory = parent
            }
          } catch {}
          if (packageVersion) break
        }
      }
      targets.set(name, { ...target, packageVersion: packageVersion ?? "0.0.0-development" })
    } catch (error) {
      throw new Error(
        `service ${name}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }
  for (const [name, participant] of Object.entries(options.participants ?? {})) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || targets.has(name))
      throw new Error(`external participant identity collision ${name}`)
    if (participant.protocol !== "external")
      throw new Error(`registered participant ${name} must declare external protocol`)
    targets.set(name, {
      name,
      protocol: "external",
      defaultPort: 0,
      start: async () => participant,
    })
  }
  assertFleetConfig(
    config,
    Object.fromEntries(
      [...targets].map(([name, target]) => [
        config.services[name]?.target ?? name,
        "options" in target ? (target.options ?? {}) : {},
      ]),
    ),
  )
  const ordered = new Map<string, FleetTarget>()
  const visiting = new Set<string>()
  const visit = (name: string, chain: string[]) => {
    if (ordered.has(name)) return
    if (!targets.has(name)) throw new Error(`unknown dependency ${[...chain, name].join(" -> ")}`)
    if (visiting.has(name)) throw new Error(`dependency cycle ${[...chain, name].join(" -> ")}`)
    visiting.add(name)
    const dependencies =
      config.services[name]?.dependsOn ?? options.participants?.[name]?.dependencies ?? []
    if (!Array.isArray(dependencies) || dependencies.some((d) => typeof d !== "string"))
      throw new Error(`services.${name}.dependsOn must be a list of instance names`)
    for (const dependency of dependencies) visit(dependency, [...chain, name])
    visiting.delete(name)
    ordered.set(name, targets.get(name) as FleetTarget)
  }
  for (const name of targets.keys()) visit(name, [])
  return ordered
}

/** Policy errors are configuration errors and must precede listener creation. */
export function validateFleetPolicies(options: FleetOptions) {
  if (options.archiveCompatibility) {
    validateCompatibilityTags(options.archiveCompatibility.tags)
    if (
      options.archiveCompatibility.missing !== undefined &&
      !["allow", "reject"].includes(options.archiveCompatibility.missing)
    )
      throw new Error("archiveCompatibility.missing must be allow or reject")
  }
  if (options.journal && !options.repository)
    throw new Error("durable operation journal requires an archive repository")
  if (options.cors) {
    if (
      !Array.isArray(options.cors.origins) ||
      options.cors.origins.some((o) => {
        try {
          const u = new URL(o)
          return !["http:", "https:"].includes(u.protocol) || u.origin !== o
        } catch {
          return true
        }
      })
    )
      throw new Error("cors.origins must contain explicit HTTP origins")
    if (
      options.cors.methods?.some(
        (m) => !["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"].includes(m),
      ) ||
      options.cors.headers?.some((h) => !/^[a-zA-Z0-9-]+$/.test(h))
    )
      throw new Error("invalid CORS methods/headers")
  }
  for (const [key, value] of Object.entries(options.limits ?? {})) {
    if (!["maxNamespaces", "maxListeners", "connections"].includes(key))
      throw new Error(`unsupported namespace budget ${key}`)
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid limit ${key}`)
  }
  for (const [key, value] of Object.entries(options.retention ?? {}))
    if (!["maxCount", "ttlMs"].includes(key) || !Number.isSafeInteger(value) || value < 1)
      throw new Error(`invalid retention ${key}`)
  if (
    options.backupPolicy &&
    (!options.repository ||
      !Number.isSafeInteger(options.backupPolicy.intervalMs) ||
      options.backupPolicy.intervalMs < 10 ||
      (options.backupPolicy.keep !== undefined &&
        (!Number.isSafeInteger(options.backupPolicy.keep) || options.backupPolicy.keep < 1)))
  )
    throw new Error("backup policy requires a repository, intervalMs >= 10 and positive retention")
  if (
    options.expiry &&
    (!Number.isSafeInteger(options.expiry.idleMs) ||
      options.expiry.idleMs < 1 ||
      (options.expiry.intervalMs !== undefined &&
        (!Number.isSafeInteger(options.expiry.intervalMs) || options.expiry.intervalMs < 10)) ||
      (options.expiry.finalBackup && !options.repository))
  )
    throw new Error("invalid expiry policy or missing final-backup repository")
  for (const duration of [
    options.hookTimeoutMs,
    options.initializationTimeoutMs,
    options.shutdownTimeoutMs,
  ])
    if (duration !== undefined && (!Number.isSafeInteger(duration) || duration < 1))
      throw new Error("hook deadlines must be positive integer milliseconds")
}
