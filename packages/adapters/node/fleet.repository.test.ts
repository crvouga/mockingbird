import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sealArchive } from "./src/fleet-archive.js"
import { filesystemRepository, s3Repository } from "./src/fleet-repository.js"

const archive = (now = 1) =>
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

test("filesystem repository publishes only verified immutable objects and survives reopen (#390)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "archive-repo-"))
  try {
    const repo = filesystemRepository(dir),
      a = archive(),
      id = await repo.put(a)
    await repo.publishLatest(id)
    expect(await filesystemRepository(dir).get(id)).toEqual(a)
    expect(await filesystemRepository(dir).latest()).toBe(id)
    expect(await repo.put(a)).toBe(id)
    await expect(repo.get("missing")).rejects.toThrow()
    const b = archive(2),
      bid = await repo.put(b)
    await writeFile(join(dir, `${bid}.json`), "corrupt")
    await expect(repo.publishLatest(bid)).rejects.toThrow()
    expect((await readFile(join(dir, "latest"), "utf8")).trim()).toBe(id)
    await expect(repo.delete(id)).rejects.toThrow("latest")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("S3 repository signs path-style requests, bounds reads and never advances pointer after failed upload/verification (#390)", async () => {
  const objects = new Map<string, string>()
  let interrupted = false,
    corrupt = false,
    signed = false
  const transport: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)),
      method = init?.method ?? "GET",
      key = decodeURIComponent(url.pathname)
    signed ||=
      new Headers(init?.headers).get("authorization")?.startsWith("AWS4-HMAC-SHA256 ") === true
    expect(url.host).toBe("backup.example.test")
    expect(key).toStartWith("/synthetic-backups/")
    if (method === "PUT") {
      if (interrupted && !key.endsWith("/latest")) throw new Error("synthetic interrupted upload")
      if (new Headers(init?.headers).get("if-none-match") === "*" && objects.has(key))
        return new Response("", { status: 412 })
      const text = new TextDecoder().decode(init?.body as Uint8Array)
      objects.set(key, corrupt && !key.endsWith("/latest") ? "corrupt" : text)
      return new Response("", { status: 200 })
    }
    if (method === "DELETE") {
      objects.delete(key)
      return new Response(null, { status: 204 })
    }
    return objects.has(key)
      ? new Response(objects.get(key))
      : new Response("missing", { status: 404 })
  }) as typeof fetch
  const options = {
    endpoint: "https://backup.example.test",
    bucket: "synthetic-backups",
    region: "us-east-1",
    accessKeyId: "synthetic-access-id",
    secretAccessKey: "synthetic-signing-value",
    fetch: transport,
  }
  const repo = s3Repository(options),
    a = archive(),
    id = await repo.put(a)
  await repo.publishLatest(id)
  expect(signed).toBe(true)
  expect(await s3Repository(options).get(id)).toEqual(a)
  interrupted = true
  await expect(repo.put(archive(2))).rejects.toThrow("interrupted")
  expect(await repo.latest()).toBe(id)
  interrupted = false
  corrupt = true
  await expect(repo.put(archive(3))).rejects.toThrow()
  expect(await repo.latest()).toBe(id)
  await expect(repo.get("f".repeat(64))).rejects.toThrow("404")
  await expect(s3Repository({ ...options, maxBytes: 10 }).get(id)).rejects.toThrow("byte limit")
})
