import { expect, test } from "bun:test"
import { digest, sealArchive } from "./src/fleet-archive.js"
import { archiveCompatibility, migrateArchive, migrateAndVerify, type MigrationRegistry } from "./src/fleet-migrations.js"
import { incrementalArchive, materializeArchive, archiveReachability, publishIncremental, compactArchive, type ArchiveChainEntry } from "./src/fleet-incremental.js"

const archive = (value: string) => sealArchive({ format: "mockingbird.fleet/v1", sourceId: "synthetic", createdAt: new Date(0).toISOString(), namespaces: { alpha: { clock: { now: 0, frozen: true }, services: { fixture: { protocol: "http", version: 1, state: { records: [{ collection: "things", id: "1", value }] } } } } } })
const registry: MigrationRegistry = { sourceFormats: ["mockingbird.fleet/v0"], transformations: [{ id: "synthetic-fixture-0-to-1", service: "fixture", from: 0, to: 1, transform: (state) => ({ records: (state as { legacyRecords: unknown }).legacyRecords }) }] }
const legacy = () => {
  const base = archive("synthetic"), { sha256: _sha, ...header } = base
  const content = { ...header, format: "mockingbird.fleet/v0", namespaces: { alpha: { ...base.namespaces.alpha, services: { fixture: { protocol: "http", version: 0, state: { legacyRecords: [{ collection: "things", id: "1", value: "synthetic" }] } } } } } }
  return { ...content, sha256: digest(content) }
}

test("explicit migrations are deterministic, immutable and fail before publication without a supported participant path (#408)", async () => {
  const source = legacy(), unchanged = JSON.stringify(source)
  expect(archiveCompatibility(source, registry).compatible).toBe(true)
  const migrated = await migrateArchive(source, registry)
  expect(migrated.namespaces.alpha?.services.fixture?.state).toEqual({ records: [{ collection: "things", id: "1", value: "synthetic" }] })
  expect(await migrateArchive(source, registry)).toEqual(migrated)
  expect(JSON.stringify(source)).toBe(unchanged)
  expect(archiveCompatibility(source, { sourceFormats: registry.sourceFormats, transformations: [] }).compatible).toBe(false)
  let stored = 0
  await expect(migrateAndVerify(source, registry, { verify: async () => { throw new Error("synthetic rehearsal failure") }, repository: { put: async () => { stored++; return "unused" }, get: async () => migrated, list: async () => [], delete: async () => {}, latest: async () => undefined, publishLatest: async () => {} } })).rejects.toThrow("rehearsal failure")
  expect(stored).toBe(0)
})

test("incremental chains materialize the same full state, reject missing/corrupt bases, and retain reachable objects (#423)", async () => {
  const base = archive("one"), next = archive("two"), last = archive("three")
  const first = incrementalArchive(base, next), second = incrementalArchive(next, last, first.sha256)
  const store = new Map<string, ArchiveChainEntry>([[base.sha256, base], [first.sha256, first], [second.sha256, second]])
  const load = async (id: string) => { const entry = store.get(id); if (!entry) throw new Error("missing chain component"); return entry }
  expect(await materializeArchive(second, load)).toEqual(last)
  expect(new Set(await archiveReachability([second.sha256], load))).toEqual(new Set([second.sha256, first.sha256, base.sha256]))
  store.delete(base.sha256)
  await expect(materializeArchive(second, load)).rejects.toThrow("missing")
  store.set(base.sha256, { ...base, sha256: "corrupt" })
  await expect(materializeArchive(second, load)).rejects.toThrow("corrupt")
})

test("incremental publication and compaction verify dependencies before advancing the recovery point (#423)", async () => {
  const base = archive("one"), next = archive("two"), incremental = incrementalArchive(base, next)
  const objects = new Map<string, ArchiveChainEntry>([[base.sha256, base]])
  let latest = base.sha256, fail = false
  const store = { put: async (id: string, entry: ArchiveChainEntry) => { if (fail) throw new Error("synthetic interruption"); objects.set(id, entry) }, get: async (id: string) => { const entry = objects.get(id); if (!entry) throw new Error("missing"); return entry }, publishLatest: async (id: string) => { latest = id } }
  fail = true; await expect(publishIncremental(incremental, store)).rejects.toThrow("interruption"); expect(latest).toBe(base.sha256)
  fail = false; await publishIncremental(incremental, store); expect(latest).toBe(incremental.sha256)
  fail = true; await expect(compactArchive(incremental, store)).rejects.toThrow("interruption"); expect(latest).toBe(incremental.sha256)
  fail = false; expect(await compactArchive(incremental, store)).toBe(next.sha256); expect(latest).toBe(next.sha256)
})
