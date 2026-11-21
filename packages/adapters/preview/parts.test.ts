import { expect, test } from "bun:test"
import type { PreviewDownload } from "./src/artifacts.js"
import { createCloudflarePreviews } from "./src/cloudflare.js"
import { planPreviewSweep } from "./src/lifecycle.js"
import {
  createPreviewPart,
  createPreviewPartsManifest,
  deployPreviewParts,
  type HostedPreviewPart,
  loadPreviewPart,
  PREVIEW_PARTS_MANIFEST,
  type PreviewPart,
  type PreviewPartsHost,
  type PreviewPartsManifest,
  parsePreviewPartsManifest,
  planPreviewParts,
  previewPartAssetFiles,
  previewPartPath,
  sweepPreviewParts,
} from "./src/parts.js"

const text = (value: string) => new TextEncoder().encode(value)
const part = (app: string, input: string, source: string) =>
  createPreviewPart({
    app,
    input,
    files: [
      {
        path: "app.js",
        bytes: text(`export const app = ${JSON.stringify(source)}`),
        contentType: "text/javascript",
      },
      { path: "assets/logo.svg", bytes: text(`<svg>${app}</svg>`), contentType: "image/svg+xml" },
    ],
  })
const manifestOf = (commit: string, parts: PreviewPart[]) =>
  createPreviewPartsManifest({
    commit,
    parts: Object.fromEntries(
      parts.map((p) => [p.app, { input: p.input, pin: p.pin, bytes: p.bytes }]),
    ),
  })

/** An injected host with shared storage: a scripted object store of paths to bytes. */
const memoryHost = (options: { shared?: boolean; clock?: () => number } = {}) => {
  const objects = new Map<string, Uint8Array>()
  const stamps = new Map<string, number>()
  const manifests = new Map<string, PreviewPartsManifest>()
  const uploads: string[] = []
  let failAfter = Number.POSITIVE_INFINITY
  const put = (path: string, bytes: Uint8Array) => {
    if (uploads.length >= failAfter) throw new Error("upload interrupted")
    uploads.push(path)
    objects.set(path, bytes)
  }
  const host: PreviewPartsHost = {
    uploadPart: async (item, preview) => {
      const root = options.shared === false ? `previews/${preview}/` : ""
      for (const file of item.files)
        put(root + previewPartPath(item.app, item.pin, file.path), file.bytes)
      put(root + previewPartPath(item.app, item.pin, "part.json"), item.indexBytes)
      stamps.set(`${item.app}/${item.pin}`, options.clock?.() ?? 0)
    },
    uploadManifest: async (preview, manifest) => {
      manifests.set(preview, manifest)
    },
    ...(options.shared === false
      ? {}
      : {
          listParts: async (): Promise<HostedPreviewPart[]> =>
            [...objects.keys()]
              .filter((path) => path.endsWith("/part.json"))
              .map((path) => {
                const [, app = "", pin = ""] = path.split("/")
                return { app, pin, updatedAt: stamps.get(`${app}/${pin}`) ?? 0 }
              }),
          deletePart: async ({ app, pin }: { app: string; pin: string }) => {
            for (const path of [...objects.keys()])
              if (path.startsWith(previewPartPath(app, pin))) objects.delete(path)
          },
        }),
  }
  const fetch: PreviewDownload = async (url) => {
    const bytes = objects.get(new URL(String(url)).pathname.slice(1))
    return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 })
  }
  return {
    host,
    objects,
    manifests,
    uploads,
    fetch,
    failAfter: (count: number) => {
      failAfter = count
    },
  }
}

test("1. a PR that changes only B builds only B, uploads only B's new pin and reuses A1 and C1", async () => {
  const store = memoryHost()
  const [a1, b1, c1] = await Promise.all([
    part("a", "a-in-1", "a1"),
    part("b", "b-in-1", "b1"),
    part("c", "c-in-1", "c1"),
  ])
  const base = manifestOf("main-1", [a1, b1, c1])
  await deployPreviewParts({
    host: store.host,
    preview: "main",
    manifest: base,
    built: [a1, b1, c1],
  })

  const candidate = { a: "a-in-1", b: "b-in-2", c: "c-in-1" }
  const hosted = await store.host.listParts?.()
  const first = planPreviewParts({ base, candidate, hosted })
  expect(first.build).toEqual(["b"])
  const b2 = await part("b", "b-in-2", "b2")
  const plan = planPreviewParts({ base, candidate, built: [b2], hosted })
  expect(plan.build).toEqual([])
  expect(plan.upload).toEqual([{ app: "b", pin: b2.pin }])
  expect(plan.parts.a?.pin).toBe(a1.pin)
  expect(plan.parts.c?.pin).toBe(c1.pin)

  const manifest = createPreviewPartsManifest({ commit: "pr-head", parts: plan.parts })
  store.uploads.length = 0
  const result = await deployPreviewParts({
    host: store.host,
    preview: "pr-7",
    manifest,
    built: [b2],
  })
  expect(result.uploaded).toEqual([{ app: "b", pin: b2.pin }])
  expect(store.uploads.every((path) => path.startsWith(`parts/b/${b2.pin}/`))).toBe(true)
  expect(store.uploads.at(-1)).toBe(`parts/b/${b2.pin}/part.json`)
  expect(store.manifests.get("pr-7")?.parts).toEqual({
    a: { input: "a-in-1", pin: a1.pin, bytes: a1.bytes },
    b: { input: "b-in-2", pin: b2.pin, bytes: b2.bytes },
    c: { input: "c-in-1", pin: c1.pin, bytes: c1.bytes },
  })
})

test("2. two PRs that produce the same B pin upload it once", async () => {
  const store = memoryHost()
  const a1 = await part("a", "a-in", "a1")
  // Different input hashes (say, a comment-only change), identical output: the same pin.
  const fromPr1 = await part("b", "b-in-pr1", "b2")
  const fromPr2 = await part("b", "b-in-pr2", "b2")
  expect(fromPr2.pin).toBe(fromPr1.pin)
  await deployPreviewParts({
    host: store.host,
    preview: "main",
    manifest: manifestOf("m", [a1]),
    built: [a1],
  })
  store.uploads.length = 0
  await deployPreviewParts({
    host: store.host,
    preview: "pr-1",
    manifest: manifestOf("p1", [a1, fromPr1]),
    built: [fromPr1],
  })
  const second = await deployPreviewParts({
    host: store.host,
    preview: "pr-2",
    manifest: manifestOf("p2", [a1, fromPr2]),
    built: [fromPr2],
  })
  expect(second.uploaded).toEqual([])
  expect(store.uploads.filter((path) => path === `parts/b/${fromPr1.pin}/part.json`)).toHaveLength(
    1,
  )
})

test("3. a pin already on the host is a no-op to deploy, and a retry after an interrupted upload finishes", async () => {
  const store = memoryHost()
  const [a1, b1] = await Promise.all([part("a", "a-in", "a1"), part("b", "b-in", "b1")])
  const manifest = manifestOf("c1", [a1, b1])
  store.failAfter(3)
  await expect(
    deployPreviewParts({ host: store.host, preview: "pr", manifest, built: [a1, b1] }),
  ).rejects.toThrow("upload interrupted")
  expect(store.manifests.has("pr")).toBe(false)
  // a's files and part.json landed; b's part.json did not, so b is not listed as complete.
  expect((await store.host.listParts?.())?.map((p) => p.app)).toEqual(["a"])
  store.failAfter(Number.POSITIVE_INFINITY)
  store.uploads.length = 0
  const retry = await deployPreviewParts({
    host: store.host,
    preview: "pr",
    manifest,
    built: [a1, b1],
  })
  expect(retry.uploaded).toEqual([{ app: "b", pin: b1.pin }])
  expect(store.uploads.some((path) => path.startsWith("parts/a/"))).toBe(false)
  store.uploads.length = 0
  const again = await deployPreviewParts({ host: store.host, preview: "pr", manifest })
  expect(again.uploaded).toEqual([])
  expect(again.reused.map((p) => p.app)).toEqual(["a", "b"])
  expect(store.uploads).toEqual([])
  // A missing part that was not built is refused before anything is published.
  const c1 = await part("c", "c-in", "c1")
  await expect(
    deployPreviewParts({ host: store.host, preview: "pr", manifest: manifestOf("c2", [a1, c1]) }),
  ).rejects.toThrow(`Preview part c@${c1.pin} is not on the host and was not built`)
  expect(store.manifests.get("pr")?.commit).toBe("c1")
})

test("4. a removed preview's pins stay while another manifest references them, and go after retention", async () => {
  let now = 1_000
  const store = memoryHost({ clock: () => now })
  const [a1, b1, b2] = await Promise.all([
    part("a", "a", "a1"),
    part("b", "b1", "b1"),
    part("b", "b2", "b2"),
  ])
  await deployPreviewParts({
    host: store.host,
    preview: "pr-1",
    manifest: manifestOf("x", [a1, b1]),
    built: [a1, b1],
  })
  await deployPreviewParts({
    host: store.host,
    preview: "pr-2",
    manifest: manifestOf("y", [a1, b2]),
    built: [b2],
  })
  now = 10_000
  const removed = planPreviewSweep({
    previews: [
      { name: "pr-1", updatedAt: 1_000 },
      { name: "pr-2", updatedAt: 1_000 },
    ],
    openNames: new Set(["pr-2"]),
    owns: () => true,
    now,
    retentionMs: 60_000,
    capacity: 10,
  }).map((entry) => entry.name)
  expect(removed).toEqual(["pr-1"])
  const manifests = [...store.manifests].map(([name, manifest]) => ({ name, manifest }))
  // Within retention, nothing goes.
  expect(
    await sweepPreviewParts({ host: store.host, manifests, removed, now, retentionMs: 60_000 }),
  ).toEqual([])
  // After retention, only b1 (referenced by pr-1 alone) goes; a1 is still referenced by pr-2.
  now = 100_000
  const swept = await sweepPreviewParts({
    host: store.host,
    manifests,
    removed,
    now,
    retentionMs: 60_000,
  })
  expect(swept).toEqual([{ app: "b", pin: b1.pin, reason: "unreferenced" }])
  expect((await store.host.listParts?.())?.map((p) => `${p.app}/${p.pin}`).sort()).toEqual(
    [`a/${a1.pin}`, `b/${b2.pin}`].sort(),
  )
  // An unreadable manifest never lets a sweep delete.
  await expect(
    sweepPreviewParts({
      host: store.host,
      manifests: [{ name: "x", manifest: { format: 2 } }],
      now,
      retentionMs: 0,
    }),
  ).rejects.toThrow("Invalid preview parts manifest")
})

test("5. a host without shared storage degrades to full uploads, with the same plans otherwise", async () => {
  const store = memoryHost({ shared: false })
  const [a1, b1, b2] = await Promise.all([
    part("a", "a", "a1"),
    part("b", "b1", "b1"),
    part("b", "b2", "b2"),
  ])
  const base = manifestOf("main", [a1, b1])
  const plan = planPreviewParts({ base, candidate: { a: "a", b: "b2" }, built: [b2] })
  expect(plan.shared).toBe(false)
  expect(plan.build).toEqual([])
  expect(plan.upload).toEqual([
    { app: "a", pin: a1.pin },
    { app: "b", pin: b2.pin },
  ])
  const manifest = createPreviewPartsManifest({ commit: "pr", parts: plan.parts })
  // Every part is uploaded into the preview itself, so the reused part's bytes are needed too.
  await expect(
    deployPreviewParts({ host: store.host, preview: "pr-1", manifest, built: [b2] }),
  ).rejects.toThrow(`Preview part a@${a1.pin} is not on the host and was not built`)
  const result = await deployPreviewParts({
    host: store.host,
    preview: "pr-1",
    manifest,
    built: [a1, b2],
  })
  expect(result).toMatchObject({ shared: false, reused: [] })
  expect(result.uploaded.map((p) => p.app)).toEqual(["a", "b"])
  expect(store.uploads.every((path) => path.startsWith("previews/pr-1/parts/"))).toBe(true)
  expect(
    await sweepPreviewParts({ host: store.host, manifests: [], now: 1e9, retentionMs: 0 }),
  ).toEqual([])
  // As static files for a plain deploy: every part plus the manifest.
  const files = previewPartAssetFiles(manifest, [a1, b2])
  expect(files.map((file) => file.path)).toEqual([
    `/parts/a/${a1.pin}/app.js`,
    `/parts/a/${a1.pin}/assets/logo.svg`,
    `/parts/a/${a1.pin}/part.json`,
    `/parts/b/${b2.pin}/app.js`,
    `/parts/b/${b2.pin}/assets/logo.svg`,
    `/parts/b/${b2.pin}/part.json`,
    `/${PREVIEW_PARTS_MANIFEST}`,
  ])
})

test("6. the shell verifies each part against its pin, size and SHA-256 before executing it", async () => {
  const store = memoryHost()
  const a1 = await part("a", "a", "a1")
  const manifest = manifestOf("c", [a1])
  await deployPreviewParts({ host: store.host, preview: "pr", manifest, built: [a1] })
  const options = { baseUrl: "https://preview.example/", fetch: store.fetch }
  const loaded = await loadPreviewPart(manifest, "a", options)
  expect(loaded.pin).toBe(a1.pin)
  expect(new TextDecoder().decode(loaded.files.get("app.js")?.bytes)).toBe(
    'export const app = "a1"',
  )
  expect(loaded.files.get("assets/logo.svg")?.contentType).toBe("image/svg+xml")

  // A tampered file (same size) fails its SHA-256 check.
  const app = previewPartPath("a", a1.pin, "app.js")
  const original = store.objects.get(app) as Uint8Array
  store.objects.set(app, text('export const app = "XX"'))
  await expect(loadPreviewPart(manifest, "a", options)).rejects.toThrow(
    "Preview asset integrity mismatch",
  )
  // A truncated file fails its size check.
  store.objects.set(app, original.subarray(0, 4))
  await expect(loadPreviewPart(manifest, "a", options)).rejects.toThrow(
    "Preview asset integrity mismatch",
  )
  store.objects.set(app, original)
  // A part.json rewritten to list other hashes no longer matches the pin.
  const index = previewPartPath("a", a1.pin, "part.json")
  const forged = JSON.stringify({ ...a1.index, files: a1.index.files.slice(0, 1) })
  store.objects.set(index, text(forged.padEnd(a1.bytes, " ")))
  await expect(loadPreviewPart(manifest, "a", options)).rejects.toThrow(
    "Preview asset integrity mismatch",
  )
  await expect(loadPreviewPart(manifest, "missing", options)).rejects.toThrow("not in the manifest")
})

test("parts are validated: app names, paths, duplicates and manifests", async () => {
  await expect(createPreviewPart({ app: "../x", input: "i", files: [] })).rejects.toThrow(
    "Invalid preview part app",
  )
  for (const path of ["/abs.js", "a/../b.js", "a\\b.js", "part.json", ""])
    await expect(
      createPreviewPart({
        app: "a",
        input: "i",
        files: [{ path, bytes: text("x"), contentType: "text/plain" }],
      }),
    ).rejects.toThrow("Invalid preview part file path")
  await expect(
    createPreviewPart({
      app: "a",
      input: "i",
      files: [
        { path: "x.js", bytes: text("1"), contentType: "text/javascript" },
        { path: "x.js", bytes: text("2"), contentType: "text/javascript" },
      ],
    }),
  ).rejects.toThrow("Duplicate preview part file")
  // File order does not change the pin.
  const files = [
    { path: "b.js", bytes: text("b"), contentType: "text/javascript" },
    { path: "a.js", bytes: text("a"), contentType: "text/javascript" },
  ]
  const forward = await createPreviewPart({ app: "a", input: "1", files })
  const reverse = await createPreviewPart({ app: "a", input: "2", files: [...files].reverse() })
  expect(reverse.pin).toBe(forward.pin)
  expect(() =>
    parsePreviewPartsManifest({
      format: 1,
      commit: "c",
      parts: { a: { input: "i", pin: "nope", bytes: 1 } },
    }),
  ).toThrow("Invalid preview parts manifest entry a")
  expect(() => planPreviewParts({ candidate: { a: "1" }, built: [reverse] })).toThrow(
    "different input",
  )
})

test("recorded Cloudflare flow: a second preview sends only the changed part's assets", async () => {
  const known = new Set<string>()
  const sessions: string[][] = []
  const uploaded: string[] = []
  const previews = new Map<string, string>()
  const result = (value: unknown) => Response.json({ success: true, result: value })
  const fetch: PreviewDownload = async (url, init) => {
    const request = new Request(url, init)
    const path = new URL(request.url).pathname
    const named = path.match(/\/previews\/([^/]+)$/)?.[1]
    if (named && request.method === "GET")
      return previews.has(named)
        ? result({ id: previews.get(named), name: named, updated_on: "2026-11-21T00:00:00Z" })
        : new Response(null, { status: 404 })
    if (path.endsWith("/previews") && request.method === "POST") {
      const { name } = (await request.json()) as { name: string }
      previews.set(name, `id-${name}`)
      return result({ id: `id-${name}`, name, updated_on: "2026-11-21T00:00:00Z" })
    }
    if (path.endsWith("/deployments/latest")) return new Response(null, { status: 404 })
    if (path.endsWith("/assets-upload-session")) {
      // The worker's asset store is shared by its previews: only unknown hashes are requested.
      const { manifest } = (await request.json()) as { manifest: Record<string, { hash: string }> }
      const missing = [...new Set(Object.values(manifest).map((entry) => entry.hash))].filter(
        (hash) => !known.has(hash),
      )
      sessions.push(
        Object.keys(manifest).filter((file) => missing.includes(manifest[file]?.hash ?? "")),
      )
      return result({ jwt: "upload", buckets: missing.length ? [missing] : [] })
    }
    if (path.endsWith("/assets/upload")) {
      for (const [hash] of await request.formData()) {
        known.add(hash)
        uploaded.push(hash)
      }
      return result({ jwt: "completion" })
    }
    if (path.endsWith("/deployments")) return result({ id: "deployment" })
    throw new Error(`Unexpected ${request.method} ${path}`)
  }
  const cloudflare = createCloudflarePreviews({
    accountId: "acct",
    workerName: "w",
    token: "t",
    fetch,
  })
  const [a1, b1, c1, b2] = await Promise.all([
    part("a", "a", "a1"),
    part("b", "b1", "b1"),
    part("c", "c", "c1"),
    part("b", "b2", "b2"),
  ])
  const deploy = (name: string, manifest: PreviewPartsManifest, parts: PreviewPart[]) =>
    cloudflare.deploy({
      name,
      commit: manifest.commit,
      files: previewPartAssetFiles(manifest, parts),
      currentPullRequest: async () => ({
        state: "open",
        repository: "o/r",
        headRepository: "o/r",
        head: manifest.commit,
      }),
    })
  expect((await deploy("main", manifestOf("m", [a1, b1, c1]), [a1, b1, c1])).action).toBe(
    "deployed",
  )
  const before = uploaded.length
  expect((await deploy("pr-7", manifestOf("p", [a1, b2, c1]), [a1, b2, c1])).action).toBe(
    "deployed",
  )
  expect(sessions[1]?.sort()).toEqual(
    [
      `/parts/b/${b2.pin}/app.js`,
      `/parts/b/${b2.pin}/part.json`,
      `/${PREVIEW_PARTS_MANIFEST}`,
    ].sort(),
  )
  // b's logo did not change, so even inside the changed part it is not sent again.
  expect(uploaded.length - before).toBe(3)
})
