import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  createRuntime,
  DEFAULT_TOKEN,
  VERCEL_BLOB_PRESETS,
  type VercelBlobRuntime,
} from "./src/index.js"
import { consumer, type UploadReply } from "./test/consumer.js"

const admin = (
  runtime: VercelBlobRuntime,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  runtime.fetch(
    new Request(`http://mock.local/__admin${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...headers,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  )
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const upload = async (r: Response) => {
  expect(r.status).toBe(200)
  return json<UploadReply>(r)
}
const bytes = async (r: Response) => Array.from(new Uint8Array(await r.arrayBuffer()))
test("arbitrary string/Uint8Array bytes, SHA-256 ETag, headers, HEAD and conditional public reads", async () => {
  const runtime = createRuntime()
  const client = consumer(runtime)
  try {
    const data = new Uint8Array([0, 255, 128, 10, 13, 9])
    const reply = await upload(
      await client.put("fixtures/雪.bin", data, { type: "application/x-fixture", maxAge: 12 }),
    )
    const read = await runtime.fetch(new Request(reply.url))
    expect(await bytes(read)).toEqual([...data])
    expect(read.headers.get("content-type")).toBe("application/x-fixture")
    expect(read.headers.get("content-length")).toBe("6")
    expect(read.headers.get("cache-control")).toBe("public, max-age=12")
    expect(reply.etag).toBe(`"${createHash("sha256").update(data).digest("hex")}"`)
    const head = await runtime.fetch(new Request(reply.downloadUrl, { method: "HEAD" }))
    expect(await head.text()).toBe("")
    expect(head.headers.get("content-length")).toBe("6")
    expect(head.headers.get("content-disposition")).toContain("attachment;")
    const unchanged = await runtime.fetch(
      new Request(reply.url, { headers: { "if-none-match": reply.etag } }),
    )
    expect(unchanged.status).toBe(304)
    expect(await unchanged.text()).toBe("")
    const text = await upload(await client.put("text.txt", "fixture unicode 雪\n"))
    expect(await (await runtime.fetch(new Request(text.url))).text()).toBe("fixture unicode 雪\n")
  } finally {
    runtime.stop?.()
  }
})
test("duplicate writes fail without changing bytes; overwrite and conditional batch delete are atomic", async () => {
  const runtime = createRuntime()
  const client = consumer(runtime)
  try {
    const first = await upload(await client.put("a.bin", "first"))
    expect((await client.put("a.bin", "duplicate")).status).toBe(400)
    expect(await (await runtime.fetch(new Request(first.url))).text()).toBe("first")
    const second = await upload(await client.put("a.bin", "second", { overwrite: true }))
    expect(second.url).toBe(first.url)
    expect(second.etag).not.toBe(first.etag)
    const b = await upload(await client.put("b.bin", "other"))
    const rejected = await client.request("/api/blob/delete", {
      method: "POST",
      headers: { "content-type": "application/json", "x-if-match": second.etag },
      body: JSON.stringify({ urls: [second.url, b.url] }),
    })
    expect(rejected.status).toBe(412)
    expect((await client.head(second.url)).status).toBe(200)
    expect((await client.head(b.url)).status).toBe(200)
    expect((await client.del(["a.bin", b.url, "missing"])).status).toBe(200)
    expect((await client.del([second.url, b.url])).status).toBe(200)
    expect(runtime.instance().state.blobs.count()).toBe(0)
  } finally {
    runtime.stop?.()
  }
})
test("lexical prefix cursor pages reach each object once and folded folders stay separate", async () => {
  const runtime = createRuntime({
    fixtures: [
      { pathname: "file2.txt", bytes: "2" },
      { pathname: "file10.txt", bytes: "10" },
      { pathname: "file1.txt", bytes: "1" },
      { pathname: "folder/a.txt", bytes: "a" },
    ],
  })
  const client = consumer(runtime)
  try {
    let cursor = ""
    const names: string[] = []
    for (let i = 0; i < 10; i++) {
      const page = await json<{ blobs: { pathname: string }[]; cursor?: string; hasMore: boolean }>(
        await client.list({ prefix: "file", limit: "1", cursor }),
      )
      names.push(...page.blobs.map((b) => b.pathname))
      if (!page.hasMore) break
      expect(page.cursor).toBeDefined()
      cursor = page.cursor ?? ""
    }
    expect(names).toEqual(["file1.txt", "file10.txt", "file2.txt"])
    expect(new Set(names).size).toBe(3)
    const folded = await json<{ folders: string[]; blobs: unknown[] }>(
      await client.list({ mode: "folded" }),
    )
    expect(folded.folders).toEqual(["folder/"])
    expect(folded.blobs.length).toBe(3)
  } finally {
    runtime.stop?.()
  }
})
test("namespace headers, URL prefixes and credential bindings isolate concurrent writes and reset fixtures", async () => {
  const runtime = createRuntime({ fixtures: [{ pathname: "seed.txt", bytes: "fixture-seed" }] })
  try {
    const a = consumer(runtime, "a"),
      b = consumer(runtime, "b")
    const [aa, bb] = await Promise.all([a.put("shared.bin", "a"), b.put("shared.bin", "b")])
    const ar = await upload(aa),
      br = await upload(bb)
    expect(await (await runtime.fetch(new Request(ar.url))).text()).toBe("a")
    expect(await (await runtime.fetch(new Request(br.url))).text()).toBe("b")
    expect((await b.head(ar.url)).status).toBe(404)
    expect((await b.del([ar.url])).status).toBe(200)
    expect((await a.head(ar.url)).status).toBe(200)
    const prefix = await runtime.fetch(
      new Request("http://mock.local/__admin/ns/a/api/blob?url=shared.bin", {
        headers: { authorization: `Bearer ${DEFAULT_TOKEN}` },
      }),
    )
    expect(prefix.status).toBe(200)
    runtime.credentials.set(DEFAULT_TOKEN, "a")
    expect((await consumer(runtime).head("shared.bin")).status).toBe(200)
    runtime.credentials.set(DEFAULT_TOKEN, "default")
    const [x, y] = await Promise.all([a.put("race.bin", "x"), a.put("race.bin", "y")])
    expect([x.status, y.status].sort()).toEqual([200, 400])
    expect((await admin(runtime, "/reset", {}, { "x-mockingbird-namespace": "a" })).status).toBe(
      200,
    )
    expect((await a.head("shared.bin")).status).toBe(404)
    expect((await a.head("seed.txt")).status).toBe(200)
    expect((await b.head("shared.bin")).status).toBe(200)
  } finally {
    runtime.stop?.()
  }
})
test("seed/read controls, configurable public origin and download expiry use the shared clock", async () => {
  const runtime = createRuntime()
  const client = consumer(runtime)
  try {
    expect((await admin(runtime, "/clock", { set: 1700000000000, freeze: true })).status).toBe(200)
    expect(
      (await admin(runtime, "/store/origin", { origin: "https://public.fixture" })).status,
    ).toBe(200)
    const seeded = await json<{ id: string; url: string }>(
      await admin(runtime, "/store/blobs", { pathname: "seed.bin", bytes: [0, 255] }),
    )
    expect(seeded.url.startsWith("https://public.fixture/")).toBe(true)
    expect(
      (await json<{ bytes: number[] }>(await admin(runtime, `/store/blobs/${seeded.id}/bytes`)))
        .bytes,
    ).toEqual([0, 255])
    const metadata = await admin(runtime, "/store/blobs")
    expect(await metadata.text()).not.toContain('"bytes"')
    const grant = await json<{ id: string; url: string }>(
      await admin(runtime, "/store/downloads", { blobId: seeded.id, expiresInMs: 1000 }),
    )
    expect((await runtime.fetch(new Request(grant.url))).status).toBe(200)
    await admin(runtime, "/clock", { advance: 1000 })
    expect((await runtime.fetch(new Request(grant.url))).status).toBe(403)
    expect((await runtime.fetch(new Request(seeded.url))).status).toBe(200)
    const next = await json<{ id: string; url: string }>(
      await admin(runtime, "/store/downloads", { blobId: seeded.id, expiresInMs: 1000 }),
    )
    expect((await admin(runtime, `/store/downloads/${next.id}/expire`, {})).status).toBe(200)
    expect((await runtime.fetch(new Request(next.url))).status).toBe(403)
    expect((await client.head("seed.bin")).status).toBe(200)
  } finally {
    runtime.stop?.()
  }
})
test("multipart stages keep partial bytes invisible; a failed part can be retried and committed atomically", async () => {
  const runtime = createRuntime()
  const client = consumer(runtime)
  const multipart = (action: string, body?: BodyInit, extra: Record<string, string> = {}) =>
    client.request("/api/blob/mpu?pathname=parts.bin", {
      method: "POST",
      headers: { "x-vercel-blob-access": "public", "x-mpu-action": action, ...extra },
      ...(body !== undefined ? { body } : {}),
    })
  try {
    const created = await json<{ key: string; uploadId: string }>(await multipart("create"))
    const headers = {
      "x-mpu-key": encodeURIComponent(created.key),
      "x-mpu-upload-id": created.uploadId,
      "x-mpu-part-number": "1",
    }
    expect((await admin(runtime, "/faults/presets/partial_multipart", {})).status).toBe(201)
    expect((await multipart("upload", new Uint8Array([0, 255]), headers)).status).toBe(503)
    expect(runtime.instance().state.parts.count()).toBe(0)
    expect((await client.head("parts.bin")).status).toBe(404)
    const part = await json<{ etag: string }>(
      await multipart("upload", new Uint8Array([0, 255]), headers),
    )
    const inspect = await admin(runtime, "/store/uploads")
    expect(await inspect.text()).not.toContain('"bytes"')
    const completeHeaders = { ...headers, "content-type": "application/json" }
    expect(
      (
        await multipart(
          "complete",
          JSON.stringify([{ etag: '"wrong"', partNumber: 1 }]),
          completeHeaders,
        )
      ).status,
    ).toBe(400)
    expect(runtime.instance().state.blobs.count()).toBe(0)
    const result = await upload(
      await multipart(
        "complete",
        JSON.stringify([{ etag: part.etag, partNumber: 1 }]),
        completeHeaders,
      ),
    )
    expect(await bytes(await runtime.fetch(new Request(result.url)))).toEqual([0, 255])
    const replay = await upload(
      await multipart(
        "complete",
        JSON.stringify([{ etag: part.etag, partNumber: 1 }]),
        completeHeaders,
      ),
    )
    expect(replay).toEqual(result)
    expect(runtime.instance().state.blobs.count()).toBe(1)
  } finally {
    runtime.stop?.()
  }
})
test("vendor error envelopes, every catalog preset, custom reserved prefix, journal privacy and Timeline", async () => {
  const runtime = createRuntime({ fixtures: [{ pathname: "seed.txt", bytes: "fixture-original" }] })
  const client = consumer(runtime)
  try {
    const missing = await runtime.fetch(new Request("http://mock.local/api/blob"))
    expect(missing.status).toBe(403)
    expect(
      (
        await runtime.fetch(
          new Request("http://mock.local/api/blob", {
            headers: { authorization: "Bearer constructor" },
          }),
        )
      ).status,
    ).toBe(403)
    expect(await missing.json()).toEqual({ error: { code: "forbidden", message: "Access denied" } })
    expect((await client.put("invalid//path", "x")).status).toBe(400)
    expect(
      (
        await client.request("/api/blob/delete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        })
      ).status,
    ).toBe(400)
    const presets = await json<{ presets: { name: string }[] }>(
      await admin(runtime, "/faults/presets"),
    )
    // The emulator's own presets, beside the standard ones every emulator has.
    expect(presets.presets.map((p) => p.name)).toEqual(
      expect.arrayContaining(Object.keys(VERCEL_BLOB_PRESETS)),
    )
    for (const [name, status] of [
      ["conflict", 400],
      ["truncated_upload", 400],
      ["rate_limited", 429],
      ["server_error", 503],
    ] as const) {
      await admin(runtime, `/faults/presets/${name}`, {})
      expect((await client.put(`${name}.bin`, "fixture-body-not-journaled")).status).toBe(status)
    }
    expect(runtime.instance().state.blobs.count()).toBe(1)
    await admin(runtime, "/faults/presets/network_reset", {})
    await expect(client.put("dropped.bin", "x")).rejects.toBeInstanceOf(TypeError)
    const journal = await admin(runtime, "/requests")
    expect(await journal.text()).not.toContain("fixture-body-not-journaled")
    const checkpoint = await json<{ id: string }>(await admin(runtime, "/checkpoints", {}))
    expect((await admin(runtime, "/branches/fixture-branch", { at: checkpoint.id })).status).toBe(
      201,
    )
    const write = await client.request("/api/blob/?pathname=seed.txt", {
      method: "PUT",
      headers: {
        "x-mockingbird-branch": "fixture-branch",
        "x-vercel-blob-access": "public",
        "x-allow-overwrite": "1",
      },
      body: "fixture-branch",
    })
    const branch = await upload(write)
    expect(
      await (
        await runtime.fetch(
          new Request(branch.url, { headers: { "x-mockingbird-branch": "fixture-branch" } }),
        )
      ).text(),
    ).toBe("fixture-branch")
    expect(await (await runtime.fetch(new Request(branch.url))).text()).toBe("fixture-original")
  } finally {
    runtime.stop?.()
  }
  const custom = createRuntime({ adminPrefix: "/controls" })
  try {
    const result = await upload(await consumer(custom).put("custom.bin", "fixture"))
    expect(new URL(result.url).pathname.startsWith("/controls/blobs/")).toBe(true)
    expect((await custom.fetch(new Request(result.url))).status).toBe(200)
    expect(
      (await custom.fetch(new Request(result.url.replace("/controls/", "/__admin/")))).status,
    ).toBe(404)
  } finally {
    custom.stop?.()
  }
})

test(
  "two-part multipart retains earlier parts across a failure and joins bytes only at completion",
  async () => {
    const runtime = createRuntime()
    const client = consumer(runtime)
    const pathname = "multi.bin"
    const call = (action: string, body?: BodyInit, headers: Record<string, string> = {}) =>
      client.request(`/api/blob/mpu?pathname=${pathname}`, {
        method: "POST",
        headers: { "x-vercel-blob-access": "public", "x-mpu-action": action, ...headers },
        ...(body !== undefined ? { body } : {}),
      })
    try {
      const created = await json<{ key: string; uploadId: string }>(await call("create"))
      const h = {
        "x-mpu-key": encodeURIComponent(created.key),
        "x-mpu-upload-id": created.uploadId,
      }
      const first = new Uint8Array(5 * 1024 * 1024)
      first[0] = 128
      first[first.length - 1] = 255
      const p1 = await json<{ etag: string }>(
        await call("upload", first, { ...h, "x-mpu-part-number": "1" }),
      )
      await admin(runtime, "/faults/presets/partial_multipart", {})
      expect(
        (await call("upload", new Uint8Array([0, 7, 255]), { ...h, "x-mpu-part-number": "2" }))
          .status,
      ).toBe(503)
      expect(runtime.instance().state.parts.count()).toBe(1)
      expect(runtime.instance().state.blobs.count()).toBe(0)
      const p2 = await json<{ etag: string }>(
        await call("upload", new Uint8Array([0, 7, 255]), { ...h, "x-mpu-part-number": "2" }),
      )
      const completeHeaders = { ...h, "content-type": "application/json" }
      expect(
        (
          await call(
            "complete",
            JSON.stringify([
              { partNumber: 2, etag: p2.etag },
              { partNumber: 1, etag: p1.etag },
            ]),
            completeHeaders,
          )
        ).status,
      ).toBe(400)
      const reply = await upload(
        await call(
          "complete",
          JSON.stringify([
            { partNumber: 1, etag: p1.etag },
            { partNumber: 2, etag: p2.etag },
          ]),
          completeHeaders,
        ),
      )
      const result = new Uint8Array(
        await (await runtime.fetch(new Request(reply.url))).arrayBuffer(),
      )
      expect(result.length).toBe(first.length + 3)
      expect(result[0]).toBe(128)
      expect(Array.from(result.slice(-4))).toEqual([255, 0, 7, 255])
      expect(
        (
          await call(
            "complete",
            JSON.stringify([{ partNumber: 2, etag: p2.etag }]),
            completeHeaders,
          )
        ).status,
      ).toBe(400)
      expect(runtime.instance().state.uploads.list()[0]?.value.result).not.toHaveProperty("bytes")
    } finally {
      runtime.stop?.()
    }
  },
  { timeout: 60000 },
)
