import { digest, type FleetArchive, sealArchive, validateArchive } from "./fleet-archive.js"

export type IncrementalArchive = {
  format: "mockingbird.incremental/v1"
  base: string
  baseSha256: string
  target: Omit<FleetArchive, "sha256" | "namespaces"> & {
    namespaces: Record<
      string,
      {
        clock: { now: number; frozen: boolean }
        services: Record<
          string,
          Omit<FleetArchive["namespaces"][string]["services"][string], "state"> & { object: string }
        >
      }
    >
  }
  targetSha256: string
  objects: Record<string, unknown>
  sha256: string
  capture: "full-sections-with-storage-deduplication"
}
export type ArchiveChainEntry = FleetArchive | IncrementalArchive
/** Each participant may fall back to a full capture; unchanged section objects are deduplicated. */
export function incrementalArchive(
  baseInput: unknown,
  targetInput: unknown,
  baseReference?: string,
): IncrementalArchive {
  const base = validateArchive(baseInput),
    target = validateArchive(targetInput)
  const known = new Set(
    Object.values(base.namespaces).flatMap((ns) =>
      Object.values(ns.services).map((s) => digest(s.state)),
    ),
  )
  const objects: Record<string, unknown> = {},
    namespaces: IncrementalArchive["target"]["namespaces"] = {}
  for (const [name, ns] of Object.entries(target.namespaces))
    namespaces[name] = {
      clock: { ...ns.clock },
      services: Object.fromEntries(
        Object.entries(ns.services).map(([service, section]) => {
          const { state, ...metadata } = section,
            hash = digest(state)
          if (!known.has(hash)) objects[hash] = structuredClone(state)
          return [service, { ...metadata, object: hash }]
        }),
      ),
    }
  const { sha256: _sha256, namespaces: _namespaces, ...header } = target
  const content = {
    format: "mockingbird.incremental/v1" as const,
    base: baseReference ?? base.sha256,
    baseSha256: base.sha256,
    target: { ...header, namespaces },
    targetSha256: target.sha256,
    objects,
    capture: "full-sections-with-storage-deduplication" as const,
  }
  return { ...content, sha256: digest(content) }
}
/** Every dependency is loaded and verified before returning a complete restorable archive. */
export async function materializeArchive(
  entry: ArchiveChainEntry,
  load: (id: string) => Promise<ArchiveChainEntry>,
  depth = 0,
): Promise<FleetArchive> {
  if (depth > 32) throw new Error("archive dependency chain exceeds 32 bases")
  if (entry.format === "mockingbird.fleet/v1") return validateArchive(entry)
  if (entry.format !== "mockingbird.incremental/v1")
    throw new Error("unsupported archive chain component")
  const { sha256, ...content } = entry
  if (sha256 !== digest(content) || !/^[a-f0-9]{64}$/.test(entry.base))
    throw new Error("corrupt incremental archive")
  const baseEntry = await load(entry.base)
  // Base identities are logical full recovery identities, not unchecked caller-provided aliases.
  const base = await materializeArchive(baseEntry, load, depth + 1)
  if (baseEntry.sha256 !== entry.base || base.sha256 !== entry.baseSha256)
    throw new Error("archive base identity mismatch")
  const objects = new Map<string, unknown>()
  for (const ns of Object.values(base.namespaces))
    for (const section of Object.values(ns.services))
      objects.set(digest(section.state), section.state)
  for (const [id, value] of Object.entries(entry.objects)) {
    if (id !== digest(value)) throw new Error("corrupt incremental object")
    objects.set(id, value)
  }
  const namespaces: FleetArchive["namespaces"] = {}
  for (const [name, ns] of Object.entries(entry.target.namespaces))
    namespaces[name] = {
      clock: ns.clock,
      services: Object.fromEntries(
        Object.entries(ns.services).map(([service, section]) => {
          const { object, ...metadata } = section
          if (!objects.has(object)) throw new Error(`missing incremental object ${object}`)
          return [service, { ...metadata, state: structuredClone(objects.get(object)) }]
        }),
      ),
    }
  const archive = sealArchive({ ...entry.target, namespaces })
  if (archive.sha256 !== entry.targetSha256)
    throw new Error("incremental target integrity mismatch")
  return validateArchive(archive)
}
/** Preview retention; bases reachable from any retained or pinned point remain protected. */
export async function archiveReachability(
  retained: string[],
  load: (id: string) => Promise<ArchiveChainEntry>,
) {
  const reachable = new Set<string>(),
    visiting = new Set<string>()
  const visit = async (id: string, depth: number): Promise<void> => {
    if (visiting.has(id) || depth > 32) throw new Error("invalid archive dependency cycle")
    if (reachable.has(id)) return
    visiting.add(id)
    const entry = await load(id)
    await materializeArchive(entry, load)
    reachable.add(id)
    if (entry.format === "mockingbird.incremental/v1") await visit(entry.base, depth + 1)
    visiting.delete(id)
  }
  for (const id of retained) await visit(id, 0)
  return [...reachable]
}
export async function publishIncremental(
  entry: IncrementalArchive,
  store: {
    put(id: string, entry: ArchiveChainEntry): Promise<void>
    get(id: string): Promise<ArchiveChainEntry>
    publishLatest(id: string): Promise<void>
  },
) {
  await materializeArchive(entry, (id) => store.get(id))
  await store.put(entry.sha256, entry)
  await materializeArchive(await store.get(entry.sha256), (id) => store.get(id))
  await store.publishLatest(entry.sha256)
}

/** Compaction publishes a verified full object before changing a recovery pointer. */
export async function compactArchive(
  entry: ArchiveChainEntry,
  store: {
    put(id: string, entry: ArchiveChainEntry): Promise<void>
    get(id: string): Promise<ArchiveChainEntry>
    publishLatest(id: string): Promise<void>
  },
) {
  const full = await materializeArchive(entry, (id) => store.get(id))
  await store.put(full.sha256, full)
  const verified = await materializeArchive(await store.get(full.sha256), (id) => store.get(id))
  if (verified.sha256 !== full.sha256) throw new Error("compaction verification failed")
  await store.publishLatest(full.sha256)
  return full.sha256
}
