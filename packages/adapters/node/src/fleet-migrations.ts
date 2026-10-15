import { digest, sealArchive, validateArchive, type FleetArchive } from "./fleet-archive.js"
import type { ArchiveRepository } from "./fleet-repository.js"

export type ParticipantMigration = { id: string; service: string; from: number; to: number; transform(state: unknown, parameters: Readonly<Record<string, unknown>>): unknown | Promise<unknown> }
export type MigrationRegistry = { sourceFormats: readonly string[]; transformations: readonly ParticipantMigration[] }
type Source = { format: string; createdAt: string; sourceId: string; sha256: string; namespaces: Record<string, { clock: { now: number; frozen: boolean }; services: Record<string, { protocol: "http" | "postgres" | "redis" | "external"; version: number; target?: string; state: unknown }> }> }
const sourceArchive = (input: unknown): Source => {
  if (!input || typeof input !== "object") throw new Error("expected migration source")
  const source = input as Source, { sha256, ...content } = source
  if (sha256 !== digest(content) || typeof source.format !== "string" || !source.namespaces || Array.isArray(source.namespaces)) throw new Error("corrupt migration source")
  return structuredClone(source)
}
export function archiveCompatibility(input: unknown, registry: MigrationRegistry) {
  const source = sourceArchive(input)
  const problems: string[] = [], steps: { namespace: string; service: string; transformations: string[] }[] = []
  if (source.format !== "mockingbird.fleet/v1" && !registry.sourceFormats.includes(source.format)) problems.push(`unsupported source format ${source.format}`)
  for (const [namespace, ns] of Object.entries(source.namespaces)) for (const [service, section] of Object.entries(ns.services ?? {})) {
    let version = section.version
    const path: string[] = [], seen = new Set<number>()
    while (version !== 1 && path.length < 16 && !seen.has(version)) {
      seen.add(version)
      const step = registry.transformations.find((t) => t.service === (section.target ?? service) && t.from === version)
      if (!step) break
      path.push(step.id); version = step.to
    }
    if (version !== 1) problems.push(`${namespace}/${service}: no migration path from codec ${section.version}`)
    steps.push({ namespace, service, transformations: path })
  }
  return { version: 1, sourceId: source.sha256, sourceFormat: source.format, targetFormat: "mockingbird.fleet/v1", compatible: problems.length === 0, problems, steps }
}
/** Explicit transformations create a new immutable destination; nothing touches a running fleet. */
export async function migrateArchive(input: unknown, registry: MigrationRegistry, parameters: Readonly<Record<string, unknown>> = {}): Promise<FleetArchive> {
  const source = sourceArchive(input), plan = archiveCompatibility(source, registry)
  if (!plan.compatible) throw new Error(plan.problems.join("; "))
  const namespaces: FleetArchive["namespaces"] = {}
  for (const [namespace, ns] of Object.entries(source.namespaces)) {
    const services: FleetArchive["namespaces"][string]["services"] = {}
    for (const [service, section] of Object.entries(ns.services)) {
      let version = section.version, state = structuredClone(section.state)
      for (let count = 0; version !== 1 && count < 16; count++) {
        const transform = registry.transformations.find((t) => t.service === (section.target ?? service) && t.from === version)
        if (!transform) throw new Error("migration path changed")
        state = await transform.transform(state, Object.freeze(structuredClone(parameters))); version = transform.to
      }
      services[service] = { ...section, version: 1, state }
    }
    namespaces[namespace] = { clock: { ...ns.clock }, services }
  }
  const content = { format: "mockingbird.fleet/v1" as const, sourceId: source.sourceId, createdAt: source.createdAt, namespaces,
    migration: { source: source.sha256, sourceFormat: source.format, transformations: plan.steps, parameters: digest(parameters) } }
  return validateArchive(sealArchive(content))
}
export async function migrateAndVerify(input: unknown, registry: MigrationRegistry, options: { parameters?: Readonly<Record<string, unknown>>; verify(archive: FleetArchive): Promise<void>; repository?: ArchiveRepository; publish?: boolean }) {
  const archive = await migrateArchive(input, registry, options.parameters)
  await options.verify(archive)
  if (options.repository) {
    const id = await options.repository.put(archive)
    if ((await options.repository.get(id)).sha256 !== archive.sha256) throw new Error("migrated archive read-back failed")
    if (options.publish) await options.repository.publishLatest(id)
  }
  return archive
}
