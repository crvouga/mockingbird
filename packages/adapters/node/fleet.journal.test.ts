import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { filesystemOperationJournal, reconcileOperation, type JournalRecord } from "./src/fleet-journal.js"
import { filesystemRepository } from "./src/fleet-repository.js"
import { RepositoryWriter, filesystemConditionalStore, type WriterState } from "./src/fleet-writer.js"
import { fileParticipant } from "./src/fleet-files.js"
import { startFleet } from "./src/fleet.js"
import { FleetClient } from "./src/fleet-client.js"

const record = (before?: string): JournalRecord => ({ version: 1, revision: 1, operationId: randomUUID(), controller: "synthetic-old-controller", namespace: "default", scope: ["default"], action: "reset", phase: "committing", timestamp: new Date(0).toISOString(), requestFingerprint: "synthetic-fingerprint", ...(before ? { before } : {}) })

test("durable journal survives controller restart, fences uncertainty and explicitly restores verified before-state (#409)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-journal-")), repo = filesystemRepository(join(dir, "repo")), journal = filesystemOperationJournal(join(dir, "journal"))
  let fleet: Awaited<ReturnType<typeof startFleet>> | undefined
  try {
    const source = await fileParticipant(join(dir, "source"), ["state"])
    fleet = await startFleet({ services: {} }, { load: async () => { throw new Error("unexpected target") }, participants: { files: source } })
    await source.write("default", "state", new TextEncoder().encode("synthetic-before"))
    const before = await repo.put(await new FleetClient(fleet.manifest.adminBase).exportArchive())
    await fleet.close()
    const interrupted = record(before); await journal.write(interrupted)
    const next = await fileParticipant(join(dir, "next"), ["state"])
    fleet = await startFleet({ services: {} }, { load: async () => { throw new Error("unexpected target") }, participants: { files: next }, repository: repo, journal })
    expect(fleet.manifest.state).toBe("recovery-required")
    await expect(next.write("default", "state", new Uint8Array())).rejects.toThrow("fenced")
    const client = new FleetClient(fleet.manifest.adminBase)
    expect((await client.request<{ interrupted: JournalRecord[] }>("recovery")).interrupted[0]?.operationId).toBe(interrupted.operationId)
    await client.request(`recovery/${interrupted.operationId}/rollback`, { body: {} })
    expect(new TextDecoder().decode(await next.read("default", "state"))).toBe("synthetic-before")
    expect(fleet.manifest.state).toBe("ready")
    await next.write("default", "state", new TextEncoder().encode("recovered"))
    expect((await journal.load())[0]?.phase).toBe("resolved")
    await expect(journal.write({ ...interrupted, revision: 2, phase: "failed" })).rejects.toThrow("revision conflict")
    const writer = new RepositoryWriter(repo, filesystemConditionalStore<WriterState>(join(dir, "writer")))
    const lease = await writer.acquire("synthetic-owner", 10000)
    const owned = writer.bind(lease)
    const publishing = { ...record(before), phase: "publishing" as const, after: before, writerGeneration: lease.generation }
    expect((await reconcileOperation(publishing, owned)).status).toBe("recovery-required")
    await owned.publishLatest(before)
    expect((await reconcileOperation(publishing, owned)).status).toBe("verified-publication")
    expect((await reconcileOperation({ ...record(), phase: "prepared" }, repo)).status).toBe("abandoned-before-commit")
  } finally { await fleet?.close(); await rm(dir, { recursive: true, force: true }) }
})

test("unavailable required journals prevent startup and mutation without a ready claim (#409)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-journal-fail-"))
  try {
    const files = await fileParticipant(join(dir, "files"), ["state"])
    await expect(startFleet({ services: {} }, { load: async () => { throw new Error("unexpected target") }, participants: { files }, repository: filesystemRepository(join(dir, "repo")), journal: { load: async () => { throw new Error("offline") }, write: async () => { throw new Error("offline") } } })).rejects.toThrow("journal unavailable")
  } finally { await rm(dir, { recursive: true, force: true }) }
})
