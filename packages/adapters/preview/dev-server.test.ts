import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DevPreview, DevPreviewBuild, DevPreviewOptions } from "./src/dev-server.js"
import { devPreview } from "./src/dev-server.js"

const dirs: string[] = []
const open: DevPreview[] = []
afterAll(async () => {
  for (const preview of open) await preview.close()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** A fixture app in a directory of its own, served on any free port, logging into `lines`. */
const fixture = async (options: Partial<DevPreviewOptions> = {}, app?: string) => {
  // The real path: esbuild names the files it read by it, and they are what is watched.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mockingbird-preview-dev-")))
  dirs.push(root)
  writeFileSync(
    join(root, "app.ts"),
    app ??
      `import { label } from "./label.ts"
export const start = async (host: HTMLElement) => {
  const { lazy } = await import("./lazy.ts")
  host.textContent = label + lazy
  return () => { host.textContent = "" }
}
`,
  )
  writeFileSync(join(root, "label.ts"), `export const label = "one"\n`)
  writeFileSync(join(root, "lazy.ts"), `export const lazy = "!"\n`)
  const lines: string[] = []
  const preview = await devPreview({
    entry: "app.ts",
    port: 0,
    debounceMs: 5,
    esbuild: { absWorkingDir: root },
    log: (line) => lines.push(line),
    ...options,
  })
  open.push(preview)
  const get = (path: string, headers: Record<string, string> = {}) =>
    preview.fetch(new Request(new URL(path, preview.url), { headers }))
  /** The next build a file change (or `rebuild()`) produces. */
  const next = () =>
    new Promise<DevPreviewBuild>((done) => {
      const off = preview.subscribe((build) => {
        off()
        done(build)
      })
    })
  return { root, preview, lines, get, next }
}

/** Reads `count` snapshots off a `/__preview/live` response. */
const snapshots = async (response: Response, count: number) => {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  const out: Record<string, unknown>[] = []
  let text = ""
  while (out.length < count) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
    for (;;) {
      const end = text.indexOf("\n\n")
      if (end < 0) break
      const data = /^data: (.*)$/m.exec(text.slice(0, end))?.[1]
      text = text.slice(end + 2)
      if (data) out.push(JSON.parse(data))
    }
  }
  return { out, reader }
}

describe("devPreview", () => {
  test("serves the page, the boot loader, version.json and the hashed app from memory", async () => {
    const { preview, get, lines } = await fixture({ title: "Lab <dev>", hostId: "system" })
    const version = preview.version()
    expect(version?.entry).toMatch(/^\.\/app-[A-Z0-9]+\.js$/)
    expect(version?.version).toBe(/-([A-Z0-9]+)\.js$/.exec(version?.entry ?? "")?.[1] as string)
    expect(preview.builds()).toEqual([
      { ok: true, version: version?.version as string, ms: expect.any(Number), changed: [] },
    ])

    const page = await get("/")
    expect(page.headers.get("cache-control")).toBe("no-store")
    const html = await page.text()
    expect(html).toContain('<main id="system"')
    expect(html).toContain("<title>Lab &lt;dev&gt;</title>")
    // A deep link is the page; a missing file is not.
    expect(await (await get("/settings/profile")).text()).toBe(html)
    expect((await get("/gone-ABCDEFGH.js")).status).toBe(404)

    expect(await (await get("/version.json")).json()).toEqual(version)
    expect(await (await get("/build.json")).json()).toEqual({ entry: version?.entry })

    const loader = await get("/preview.js")
    expect(loader.headers.get("content-type")).toContain("text/javascript")
    const source = await loader.text()
    // The dev loader: updates apply at once, and build errors show in the page.
    expect(source).toContain(`"countdownMs": 0`)
    expect(source).toContain("mockingbird-preview-dev-error")

    const app = await get(`/${version?.entry.slice(2)}`)
    expect(app.status).toBe(200)
    expect(app.headers.get("cache-control")).toContain("immutable")
    expect(app.headers.get("content-encoding")).toBeNull()
    // Readable: a dev build is not minified.
    expect(await app.text()).toContain("host.textContent = label + lazy")

    expect((await preview.fetch(new Request(preview.url, { method: "POST" }))).status).toBe(405)
    expect(lines[0]).toBe(`preview dev server: ${preview.url}`)
    expect(lines[1]).toMatch(/^built [A-Z0-9]+ in \d+ ms · \d+\.\d MB$/)
  })

  test("a saved file is a new version, pushed to open tabs; an untouched chunk keeps its URL", async () => {
    const { root, preview, get, next, lines } = await fixture()
    const first = preview.version()
    const live = await get("/__preview/live")
    expect(live.headers.get("content-type")).toContain("text/event-stream")
    const built = next()
    writeFileSync(join(root, "label.ts"), `export const label = "two"\n`)
    const build = await built
    expect(build.ok).toBe(true)
    expect(build.changed).toEqual(["label.ts"])
    const second = preview.version()
    expect(second?.version).not.toBe(first?.version)
    expect(build.version).toBe(second?.version as string)

    // The stream said: what is deployed, a build starting, the new version deployed.
    const { out, reader } = await snapshots(live, 3)
    expect(preview.tabs()).toBe(1)
    await reader.cancel()
    expect(preview.tabs()).toBe(0)
    expect(out.map((snapshot) => (snapshot.build as { state: string }).state)).toEqual([
      "deployed",
      "building",
      "deployed",
    ])
    expect(out[0]?.deployed).toEqual({ version: first?.version, at: first?.builtAt })
    expect(out[2]?.deployed).toEqual({ version: second?.version, at: second?.builtAt })
    expect(await (await get("/__preview/status")).json()).toMatchObject({
      deployed: { version: second?.version },
      build: { state: "deployed", version: second?.version },
    })

    // The version a tab still runs keeps loading, lazy chunk and all.
    expect((await get(`/${first?.entry.slice(2)}`)).status).toBe(200)
    expect(await (await get(`/${second?.entry.slice(2)}`)).text()).toContain('"two"')
    expect(lines.at(-1)).toMatch(/^rebuilt [A-Z0-9]+ in \d+ ms · .* · label\.ts · 1 tab updated$/)

    // A rebuild that changes nothing is not a new version.
    const same = await preview.rebuild()
    expect(same.version).toBe(second?.version as string)
    expect(preview.version()).toEqual(second)
  })

  test("a failing build keeps the last good version serving and says why; the fix recovers", async () => {
    const { root, preview, get, next } = await fixture()
    const good = preview.version()
    let built = next()
    writeFileSync(join(root, "label.ts"), `export const label = \n`)
    const failed = await built
    expect(failed.ok).toBe(false)
    expect(failed.version).toBe(good?.version as string)
    expect(failed.error).toContain("label.ts:")
    expect(preview.version()).toEqual(good)
    expect((await get(`/${good?.entry.slice(2)}`)).status).toBe(200)
    const status = (await (await get("/__preview/status")).json()) as {
      build: { state: string; message: string }
      deployed: { version: string }
    }
    expect(status.build.state).toBe("failed")
    expect(status.build.message).toContain("label.ts:")
    expect(status.deployed.version).toBe(good?.version as string)

    built = next()
    writeFileSync(join(root, "label.ts"), `export const label = "fixed"\n`)
    const fixed = await built
    expect(fixed.ok).toBe(true)
    expect(preview.version()?.version).not.toBe(good?.version)
  })

  test("with no good build yet the page shows the error, then the first good build serves", async () => {
    const { root, preview, get, next } = await fixture({}, `export const start = (\n`)
    expect(preview.version()).toBeUndefined()
    expect(preview.builds()[0]?.ok).toBe(false)
    const waiting = await (await get("/")).text()
    expect(waiting).toContain("The preview does not build yet")
    expect(waiting).toContain("app.ts:")
    expect((await get("/version.json")).status).toBe(503)

    const built = next()
    writeFileSync(join(root, "app.ts"), `export const start = async () => () => {}\n`)
    expect((await built).ok).toBe(true)
    expect(await (await get("/")).text()).toContain('<main id="preview"')
    expect((await get("/version.json")).status).toBe(200)
  })

  test("extra routes answer first, the status refuses other sites, and other devices get gzip", async () => {
    const { preview, get } = await fixture(
      {
        base: "/lab/",
        fetch: (request) =>
          new URL(request.url).pathname === "/__dev/" ? Response.json({ dev: true }) : undefined,
      },
      `export const start = async (host: HTMLElement) => { host.textContent = ${JSON.stringify("x".repeat(2048))}; return () => {} }\n`,
    )
    expect(preview.url.endsWith("/lab/")).toBe(true)
    expect(await (await get("/__dev/")).json()).toEqual({ dev: true })
    expect((await get("/")).status).toBe(404)
    expect(await (await get("/lab/deep/link")).text()).toContain('src="/lab/preview.js"')
    expect((await get("/lab/version.json")).status).toBe(200)
    expect((await get("/__preview/status", { "sec-fetch-site": "cross-site" })).status).toBe(403)
    expect((await get("/__preview/status", { "sec-fetch-site": "same-origin" })).status).toBe(200)

    const entry = preview.version()?.entry.slice(2)
    const far = await preview.fetch(
      new Request(`http://192.168.0.9:${preview.port}/lab/preview.js`, {
        headers: { "accept-encoding": "gzip" },
      }),
    )
    // The loader is not a hashed build output; the app's chunks are.
    expect(far.headers.get("content-encoding")).toBeNull()
    const chunk = (host: string) =>
      preview.fetch(
        new Request(`http://${host}:${preview.port}/lab/${entry}`, {
          headers: { "accept-encoding": "gzip, br" },
        }),
      )
    expect((await chunk("192.168.0.9")).headers.get("content-encoding")).toBe("gzip")
    expect((await chunk("localhost")).headers.get("content-encoding")).toBeNull()
  })

  test("serves over HTTP and steps over a taken port", async () => {
    const first = await fixture()
    const second = await fixture({ port: first.preview.port })
    expect(second.preview.port).toBeGreaterThan(first.preview.port)
    const response = await fetch(new URL("version.json", second.preview.url))
    expect(await response.json()).toEqual(second.preview.version())
    await expect(
      devPreview({
        entry: "app.ts",
        port: first.preview.port,
        strictPort: true,
        esbuild: { absWorkingDir: first.root },
        log: () => {},
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" })
  })
})
