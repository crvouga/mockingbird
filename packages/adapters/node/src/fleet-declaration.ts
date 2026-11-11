import type { ConfigService, MockingbirdConfig } from "./cli.js"
import type { ConfigIssue } from "./fleet-schema.js"

/**
 * `mockingbird.yaml`: one file that declares an organization's fleets, the same whether they run
 * on Fleet Cloud or on a developer's machine.
 *
 *   version: 1
 *   organization: acme
 *   projects:
 *     web:
 *       fleets:
 *         acme-staging:
 *           services:
 *             stripe: { durability: strict }
 *             resend: {}
 *             db: { target: postgres, protocol: postgres, local: true }
 *
 * A fleet's `services` are the entries of a local fleet configuration (`mockingbird.json`), so
 * `mockingbird-fleet serve --config mockingbird.yaml` runs the fleet locally with nothing changed.
 * Fleet Cloud reads the same entries and adds what only a hosted fleet has: durability, access,
 * a request rate. Each side ignores the keys that are the other's.
 */

export const DURABILITY_MODES = ["strict", "buffered", "ephemeral"] as const
export const ACCESS_MODES = ["open", "key"] as const

/** A service of a declared fleet: a local fleet entry plus what Fleet Cloud adds to it. */
export type DeclaredService = ConfigService & {
  /** Fleet Cloud: how much of the emulator's state survives. Default `buffered`. */
  durability?: (typeof DURABILITY_MODES)[number]
  /** Fleet Cloud, `buffered` only: milliseconds from the first unsaved change to its write. */
  flushIntervalMs?: number
  /** Fleet Cloud: public https origins the emulator may deliver webhooks to. */
  webhookOrigins?: string[]
  /**
   * Runs only in a local fleet. Fleet Cloud skips it: use this for wire-protocol servers
   * (PostgreSQL, Redis), which a hosted fleet cannot offer.
   */
  local?: boolean
}

export type DeclaredFleet = {
  name?: string
  /** Fleet Cloud: `open` (anyone with the URL) or `key` (an API key on every request). */
  access?: (typeof ACCESS_MODES)[number]
  /** Fleet Cloud: requests per minute the fleet accepts, at most the organization's ceiling. */
  requestsPerMinute?: number
  services: Record<string, DeclaredService>
}

export type Declaration = {
  version: 1
  /** The organization's slug. */
  organization: string
  /** The organization's display name. */
  name?: string
  /** Projects by slug; each holds fleets by slug. A fleet's slug is its URL: `/f/<slug>`. */
  projects: Record<string, { name?: string; fleets: Record<string, DeclaredFleet> }>
}

/** The keys of a service entry that only Fleet Cloud reads; a local fleet never sees them. */
export const CLOUD_SERVICE_KEYS = [
  "durability",
  "flushIntervalMs",
  "webhookOrigins",
  "local",
] as const

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** Whether a parsed configuration file is a declaration (as opposed to a single local fleet). */
export const isDeclaration = (value: unknown): boolean =>
  record(value) && "projects" in value && !("services" in value)

/**
 * Check a parsed `mockingbird.yaml`. Every problem is reported with the path of the key it is
 * about, all at once. Service entries are checked only for the keys Fleet Cloud adds; the local
 * fleet and Fleet Cloud each check the rest when they start the service.
 */
export function checkDeclaration(value: unknown): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  const issue = (path: string, message: string) => void issues.push({ path, message })
  const keys = (at: Record<string, unknown>, path: string, allowed: readonly string[]) => {
    for (const key of Object.keys(at))
      if (!allowed.includes(key))
        issue(
          `${path}${path ? "." : ""}${key}`,
          `unknown key; expected one of ${allowed.join(", ")}`,
        )
  }
  const slug = (name: string, path: string, what: string) => {
    if (!SLUG.test(name))
      issue(path, `${what} "${name}" must be 1 to 40 lowercase letters, digits and hyphens`)
  }
  const name = (at: Record<string, unknown>, path: string) => {
    if (at.name !== undefined && (typeof at.name !== "string" || !at.name || at.name.length > 80))
      issue(`${path}${path ? "." : ""}name`, "must be 1 to 80 characters")
  }

  if (!record(value)) return [{ path: "", message: "must be a mapping" }]
  keys(value, "", ["version", "organization", "name", "projects"])
  if (value.version !== 1) issue("version", "must be 1")
  if (typeof value.organization !== "string")
    issue("organization", "must be the organization's slug")
  else slug(value.organization, "organization", "organization")
  name(value, "")
  if (!record(value.projects)) {
    issue("projects", "must be a mapping of project slug to project")
    return issues
  }
  const fleets = new Map<string, string>()
  for (const [projectSlug, project] of Object.entries(value.projects)) {
    const projectPath = `projects.${projectSlug}`
    slug(projectSlug, projectPath, "project")
    if (!record(project)) {
      issue(projectPath, "must be a mapping")
      continue
    }
    keys(project, projectPath, ["name", "fleets"])
    name(project, projectPath)
    if (project.fleets === undefined) continue
    if (!record(project.fleets)) {
      issue(`${projectPath}.fleets`, "must be a mapping of fleet slug to fleet")
      continue
    }
    for (const [fleetSlug, fleet] of Object.entries(project.fleets)) {
      const fleetPath = `${projectPath}.fleets.${fleetSlug}`
      slug(fleetSlug, fleetPath, "fleet")
      const other = fleets.get(fleetSlug)
      if (other) issue(fleetPath, `fleet "${fleetSlug}" is also declared at ${other}`)
      fleets.set(fleetSlug, fleetPath)
      if (!record(fleet)) {
        issue(fleetPath, "must be a mapping")
        continue
      }
      keys(fleet, fleetPath, ["name", "access", "requestsPerMinute", "services"])
      name(fleet, fleetPath)
      if (fleet.access !== undefined && !ACCESS_MODES.includes(fleet.access as "open"))
        issue(`${fleetPath}.access`, `must be one of ${ACCESS_MODES.join(", ")}`)
      if (
        fleet.requestsPerMinute !== undefined &&
        !(Number.isSafeInteger(fleet.requestsPerMinute) && (fleet.requestsPerMinute as number) >= 1)
      )
        issue(`${fleetPath}.requestsPerMinute`, "must be a whole number of at least 1")
      if (fleet.services === undefined) continue
      if (!record(fleet.services)) {
        issue(`${fleetPath}.services`, "must be a mapping of service name to service")
        continue
      }
      for (const [serviceName, service] of Object.entries(fleet.services)) {
        const path = `${fleetPath}.services.${serviceName}`
        slug(serviceName, path, "service")
        // `stripe:` with nothing after it is a service with every default.
        if (service === null) continue
        if (!record(service)) {
          issue(path, "must be a mapping (or empty for every default)")
          continue
        }
        if (service.target !== undefined && typeof service.target !== "string")
          issue(`${path}.target`, "must be the name of an emulator")
        if (
          service.durability !== undefined &&
          !DURABILITY_MODES.includes(service.durability as "strict")
        )
          issue(`${path}.durability`, `must be one of ${DURABILITY_MODES.join(", ")}`)
        if (
          service.flushIntervalMs !== undefined &&
          !(
            Number.isSafeInteger(service.flushIntervalMs) &&
            (service.flushIntervalMs as number) >= 100 &&
            (service.flushIntervalMs as number) <= 60_000
          )
        )
          issue(`${path}.flushIntervalMs`, "must be a whole number from 100 to 60000")
        if (
          service.webhookOrigins !== undefined &&
          !(
            Array.isArray(service.webhookOrigins) &&
            service.webhookOrigins.every((origin) => typeof origin === "string")
          )
        )
          issue(`${path}.webhookOrigins`, "must be a list of origins")
        if (service.local !== undefined && typeof service.local !== "boolean")
          issue(`${path}.local`, "must be true or false")
        if (service.seed !== undefined && typeof service.seed !== "string")
          issue(`${path}.seed`, 'must be a string (quote numbers: seed: "42")')
        if (service.settings !== undefined && !record(service.settings))
          issue(`${path}.settings`, "must be a mapping")
      }
    }
  }
  return issues
}

/** A problem with a `mockingbird.yaml`, listing every issue with its path. */
export class DeclarationError extends Error {
  constructor(readonly issues: ConfigIssue[]) {
    super(
      `mockingbird.yaml is invalid:\n${issues.map((entry) => `  ${entry.path || "(top level)"}: ${entry.message}`).join("\n")}`,
    )
    this.name = "DeclarationError"
  }
}

/** A checked declaration with defaults filled in, or a {@link DeclarationError}. */
export function parseDeclaration(value: unknown): Declaration {
  const issues = checkDeclaration(value)
  if (issues.length > 0) throw new DeclarationError(issues)
  const input = value as Declaration
  const projects: Declaration["projects"] = {}
  for (const [projectSlug, project] of Object.entries(input.projects)) {
    const fleets: Record<string, DeclaredFleet> = {}
    for (const [fleetSlug, fleet] of Object.entries(project.fleets ?? {})) {
      const services: Record<string, DeclaredService> = {}
      for (const [serviceName, service] of Object.entries(fleet.services ?? {}))
        services[serviceName] = { ...(service ?? {}) }
      fleets[fleetSlug] = { ...fleet, services }
    }
    projects[projectSlug] = { ...project, fleets }
  }
  return { ...input, projects }
}

/** Every fleet of a declaration, with the project it belongs to. */
export const declaredFleets = (declaration: Declaration) =>
  Object.entries(declaration.projects).flatMap(([project, { fleets }]) =>
    Object.entries(fleets).map(([slug, fleet]) => ({ project, slug, fleet })),
  )

/**
 * The local fleet configuration for one fleet of a declaration: its services with the keys
 * only Fleet Cloud reads removed. With one fleet declared, `slug` may be omitted.
 */
export function localFleetConfig(declaration: Declaration, slug?: string): MockingbirdConfig {
  const fleets = declaredFleets(declaration)
  const names = fleets.map((entry) => entry.slug).join(", ")
  if (fleets.length === 0) throw new Error("mockingbird.yaml declares no fleets")
  if (slug === undefined && fleets.length > 1)
    throw new Error(`mockingbird.yaml declares several fleets; choose one with --fleet: ${names}`)
  const chosen = slug === undefined ? fleets[0] : fleets.find((entry) => entry.slug === slug)
  if (!chosen)
    throw new Error(`mockingbird.yaml declares no fleet "${slug}"; it declares: ${names}`)
  const services: Record<string, ConfigService> = {}
  for (const [name, service] of Object.entries(chosen.fleet.services)) {
    const local: Record<string, unknown> = { ...service }
    for (const key of CLOUD_SERVICE_KEYS) delete local[key]
    services[name] = local as ConfigService
  }
  return { schemaVersion: 1, services }
}
