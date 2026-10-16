import { expect, test } from "bun:test"
import { sealArchive } from "./src/fleet-archive.js"
import { s3Repository } from "./src/fleet-repository.js"
import { RepositoryWriter, s3ConditionalStore, type WriterState } from "./src/fleet-writer.js"

test("S3 release preserves verified latest across a lost response and fences a replaced owner (#434)", async () => {
  const objects = new Map<string, { body: string; etag: string }>()
  let revision = 0
  let loseReleaseResponse = false
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const key = new URL(request.url).pathname
      const current = objects.get(key)
      if (request.method === "GET")
        return current
          ? new Response(current.body, { headers: { etag: current.etag } })
          : new Response(null, { status: 404 })
      if (request.method !== "PUT") return new Response(null, { status: 405 })
      if (
        (request.headers.get("if-none-match") === "*" && current) ||
        (request.headers.has("if-match") && request.headers.get("if-match") !== current?.etag)
      )
        return new Response(null, { status: 412 })
      const body = await request.text()
      const etag = `"revision-${++revision}"`
      objects.set(key, { body, etag })
      return new Response(null, { headers: { etag } })
    },
  })
  const transport: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await fetch(input, init)
    if (loseReleaseResponse && init?.method === "PUT" && String(input).endsWith("writer.json")) {
      loseReleaseResponse = false
      await response.body?.cancel()
      throw new Error("synthetic lost release response")
    }
    return response
  }) as typeof fetch
  const options = {
    endpoint: server.url.toString(),
    bucket: "synthetic-backups",
    region: "us-east-1",
    accessKeyId: "synthetic-access-id",
    secretAccessKey: "synthetic-signing-value",
    fetch: transport,
  }
  try {
    const repository = s3Repository(options)
    const control = s3ConditionalStore<WriterState>(options)
    const writer = new RepositoryWriter(repository, control, () => 100)
    const lease = await writer.acquire("first", 1000)
    const id = await repository.put(
      sealArchive({
        format: "mockingbird.fleet/v1",
        createdAt: new Date(0).toISOString(),
        sourceId: "synthetic",
        namespaces: {},
      }),
    )
    await writer.publish(id, lease)
    loseReleaseResponse = true
    await expect(writer.release(lease)).rejects.toThrow("lost release response")
    expect(await writer.release(lease)).toBe("already-released")
    const replacement = await writer.acquire("replacement", 1000)
    expect(replacement.generation).toBe(lease.generation + 1)
    expect(await writer.latest()).toBe(id)
    await expect(writer.release(lease)).rejects.toThrow("stale")
    await expect(writer.renew(lease, 1000)).rejects.toThrow("stale")
    await expect(writer.publish(id, lease)).rejects.toThrow("stale")
    expect((await control.read())?.value.lease).toEqual(replacement)
    expect(await writer.latest()).toBe(id)
  } finally {
    await server.stop(true)
  }
})
