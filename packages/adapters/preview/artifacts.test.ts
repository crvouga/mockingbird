import { expect, test } from "bun:test"
import {
  createPreviewArtifact,
  loadPreviewArtifact,
  type PreviewDownload,
} from "./src/artifacts.js"
import { planPreviewSweep, selectPreviewAction } from "./src/lifecycle.js"

test("artifact bytes, source commit and compressed contents are verified", async () => {
  const source = new TextEncoder().encode("globalThis.fixture = true")
  const packed = new Uint8Array(
    await new Response(
      new Blob([source]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  )
  const manifest = await createPreviewArtifact(packed, {
    commit: "commit-a",
    url: "https://preview.test/worker.bin",
    encoding: "gzip",
  })
  const download: PreviewDownload = async (_url, init) => {
    expect(init?.cache).toBe("no-store")
    expect(init?.redirect).toBe("error")
    return new Response(packed)
  }
  expect(
    await loadPreviewArtifact(manifest, { fetch: download, expectedCommit: "commit-a" }),
  ).toEqual(source)
  await expect(
    loadPreviewArtifact(manifest, { fetch: download, expectedCommit: "commit-b" }),
  ).rejects.toThrow("Stale")
  await expect(
    loadPreviewArtifact(manifest, { fetch: async () => new Response("wrong") }),
  ).rejects.toThrow("integrity")
  await expect(
    loadPreviewArtifact(manifest, { fetch: async () => new Response(null, { status: 404 }) }),
  ).rejects.toThrow("404")
  await expect(
    loadPreviewArtifact({ ...manifest, format: 2 }, { fetch: download }),
  ).rejects.toThrow("Unsupported")
})
test("decompression bombs are limited", async () => {
  const packed = new Uint8Array(
    await new Response(
      new Blob([new Uint8Array(100_000)]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  )
  const manifest = await createPreviewArtifact(packed, {
    commit: "a",
    url: "https://preview.test/worker",
    encoding: "gzip",
  })
  await expect(
    loadPreviewArtifact(manifest, { fetch: async () => new Response(packed), maximumBytes: 1000 }),
  ).rejects.toThrow("size limit")
})
test("current PR facts override stale events, and sweeps preserve unmanaged names", () => {
  const facts = {
    state: "open" as const,
    repository: "org/repo",
    headRepository: "org/repo",
    head: "new",
  }
  expect(selectPreviewAction(facts, "old")).toBe("skip")
  expect(selectPreviewAction({ ...facts, headRepository: "fork/repo" }, "new")).toBe("skip")
  expect(selectPreviewAction({ ...facts, state: "closed" }, "old")).toBe("remove")
  expect(selectPreviewAction(facts, "new")).toBe("deploy")
  expect(
    planPreviewSweep({
      previews: [
        { name: "pr-orphan", updatedAt: 99 },
        { name: "pr-old", updatedAt: 1 },
        { name: "pr-capacity", updatedAt: 95 },
        { name: "pr-new", updatedAt: 99 },
        { name: "production", updatedAt: 0 },
      ],
      openNames: new Set(["pr-old", "pr-capacity", "pr-new"]),
      owns: (name) => name.startsWith("pr-"),
      now: 100,
      retentionMs: 10,
      capacity: 1,
    }),
  ).toEqual([
    { name: "pr-capacity", reason: "capacity" },
    { name: "pr-old", reason: "expired" },
    { name: "pr-orphan", reason: "orphaned" },
  ])
})
