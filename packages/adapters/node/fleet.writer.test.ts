import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sealArchive } from "./src/fleet-archive.js"
import { filesystemRepository } from "./src/fleet-repository.js"
import {
  filesystemConditionalStore,
  RepositoryWriter,
  s3ConditionalStore,
  type WriterState,
} from "./src/fleet-writer.js"

const archive = (now: number) =>
  sealArchive({
    format: "mockingbird.fleet/v1",
    createdAt: new Date(now).toISOString(),
    sourceId: "synthetic",
    namespaces: {
      default: {
        clock: { now, frozen: true },
        services: { fixture: { protocol: "http", version: 1, state: { records: [] } } },
      },
    },
  })

test("shared repository ownership and conditional recovery publication fence a delayed previous writer (#406)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-writer-"))
  try {
    const repository = filesystemRepository(join(dir, "archives")),
      control = filesystemConditionalStore<WriterState>(join(dir, "writer.json"))
    let now = 100
    const first = new RepositoryWriter(repository, control, () => now),
      second = new RepositoryWriter(
        repository,
        filesystemConditionalStore(join(dir, "writer.json")),
        () => now,
      )
    const acquired = await Promise.allSettled([
      first.acquire("first", 100),
      second.acquire("second", 100),
    ])
    expect(acquired.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const old = (
      acquired.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<
        Awaited<ReturnType<typeof first.acquire>>
      >
    ).value
    const oldId = await repository.put(archive(1))
    now = 201
    await expect(second.acquire("replacement", 100)).rejects.toThrow("explicit takeover")
    const replacement = await second.acquire("replacement", 100, true),
      newId = await repository.put(archive(2))
    await second.publish(newId, replacement)
    await expect(first.publish(oldId, old)).rejects.toThrow("stale")
    expect(await first.latest()).toBe(newId)
    const state = await control.read()
    expect(await control.compareAndSwap("not-current", state?.value as WriterState)).toBe(false)
    expect(await first.latest()).toBe(newId)
    now = 400
    await expect(second.publish(oldId, replacement)).rejects.toThrow("expired")
    expect(await second.latest()).toBe(newId)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("S3 ownership refuses a provider without the ETag contract required for conditional writes (#406)", async () => {
  const control = s3ConditionalStore<WriterState>({
    endpoint: "https://backup.example.test",
    bucket: "synthetic-backups",
    region: "us-east-1",
    accessKeyId: "synthetic-access-id",
    secretAccessKey: "synthetic-signing-value",
    fetch: (async () => Response.json({})) as unknown as typeof fetch,
  })
  await expect(control.read()).rejects.toThrow("lacks required ETag")
})

test("voluntary release preserves recovery and fences old writers (#434)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-release-"))
  try {
    const repository = filesystemRepository(join(dir, "archives"))
    const control = filesystemConditionalStore<WriterState>(join(dir, "writer.json"))
    const writer = new RepositoryWriter(repository, control, () => 100)
    const lease = await writer.acquire("first", 1000)
    const id = await repository.put(archive(1))
    await writer.publish(id, lease)
    expect(await writer.release(lease)).toBe("released")
    expect(await writer.release(lease)).toBe("already-released")
    await expect(writer.renew(lease, 100)).rejects.toThrow("stale")
    await expect(writer.publish(id, lease)).rejects.toThrow("stale")
    const replacement = await writer.acquire("next", 1000)
    expect(replacement.generation).toBe(lease.generation + 1)
    expect(await writer.latest()).toBe(id)
    await expect(writer.release(lease)).rejects.toThrow("stale")
    await expect(writer.renew(lease, 100)).rejects.toThrow("stale")
    await expect(writer.publish(id, lease)).rejects.toThrow("stale")
    await writer.renew(replacement, 1000)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("release reports CAS conflicts and unavailable storage without clearing state (#434)", async () => {
  const repository = {} as ConstructorParameters<typeof RepositoryWriter>[0]
  let unavailable = false
  const lease = { id: "synthetic-lease", owner: "first", generation: 1, expiresAt: 200 }
  const control = {
    kind: "s3-etag" as const,
    read: async () => ({ revision: "r1", value: { lease } }),
    compareAndSwap: async () => {
      if (unavailable) throw new Error("storage unavailable")
      return false
    },
  }
  const writer = new RepositoryWriter(repository, control, () => 100)
  await expect(writer.release(lease)).rejects.toThrow("release conflict")
  unavailable = true
  await expect(writer.release(lease)).rejects.toThrow("storage unavailable")
  expect((await control.read()).value.lease).toEqual(lease)
})
