import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runPreviewCli } from "./src/cli-main.js"
import { createPreviewDevServer, type PreviewDevServer } from "./src/dev-server.js"
import { createLivePreview, type EventSourceLike, type PreviewVersion } from "./src/live.js"
import type { PreviewStatusSnapshot } from "./src/preview-status.js"

const root = mkdtempSync(join(tmpdir(), "mockingbird-preview-dev-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let dirs = 0
/** A consumer project: `src/app.txt` is its source; its build copies it into a hashed entry. */
const project = () => {
  const dir = join(root, `p${++dirs}`)
  mkdirSync(join(dir, "src"), { recursive: true })
  mkdirSync(join(dir, "dist"), { recursive: true })
  writeFileSync(join(dir, "src", "app.txt"), "one")
  writeFileSync(join(dir, "src", "state.txt"), "schema-1")
  let builds = 0
  const build = () => {
    builds++
    const source = readFileSync(join(dir, "src", "app.txt"), "utf8")
    if (source === "broken") throw new Error("syntax error in app.txt")
    const entry = `./app-${source}.js`
    writeFileSync(
      join(dir, "dist", entry.slice(2)),
      `export const value = ${JSON.stringify(source)}`,
    )
    writeFileSync(join(dir, "dist", "index.html"), "<!doctype html><main id=preview></main>")
    writeFileSync(join(dir, "dist", "build.json"), JSON.stringify({ entry }))
    writeFileSync(
      join(dir, "dist", "version.json"),
      JSON.stringify({
        version: "development",
        builtAt: new Date().toISOString(),
        entry,
        stateVersion: readFileSync(join(dir, "src", "state.txt"), "utf8"),
      }),
    )
  }
  return { dir, build, builds: () => builds }
}

const until = async (check: () => boolean | Promise<boolean>, ms = 5_000) => {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Just enough of `EventSource` over `fetch` (Bun has none). */
const fetchEventSource = () =>
  class implements EventSourceLike {
    readyState = 0
    #abort = new AbortController()
    #listeners = new Map<string, ((event: { data?: unknown }) => void)[]>()
    constructor(url: string) {
      void this.#run(url)
    }
    addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
      this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener])
    }
    close() {
      this.readyState = 2
      this.#abort.abort()
    }
    #emit(type: string, data?: string) {
      for (const listener of this.#listeners.get(type) ?? []) listener({ data })
    }
    async #run(url: string) {
      try {
        const response = await fetch(url, { signal: this.#abort.signal })
        if (!response.body) throw new Error("no body")
        this.readyState = 1
        this.#emit("open")
        const decoder = new TextDecoder()
        let buffer = ""
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true })
          let end = buffer.indexOf("\n\n")
          while (end >= 0) {
            const block = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            const type = /^event: (.*)$/m.exec(block)?.[1]
            const data = /^data: (.*)$/m.exec(block)?.[1]
            if (type && data !== undefined) this.#emit(type, data)
            end = buffer.indexOf("\n\n")
          }
        }
      } catch {
        if (this.readyState !== 2) this.#emit("error")
      }
    }
  }

/** Reads `/__preview/live` and collects the snapshots it pushes. */
const follow = (server: PreviewDevServer) => {
  const snapshots: PreviewStatusSnapshot[] = []
  const Source = fetchEventSource()
  const source = new Source(`${server.url}/__preview/live`)
  source.addEventListener("snapshot", (event) =>
    snapshots.push(JSON.parse(String(event.data)) as PreviewStatusSnapshot),
  )
  return { snapshots, close: () => source.close() }
}

describe("createPreviewDevServer", () => {
  test("builds, serves, and pushes each rebuild a watched change starts to open tabs", async () => {
    const p = project()
    const server = await createPreviewDevServer({
      cwd: p.dir,
      outdir: "dist",
      build: p.build,
      watch: ["src"],
      debounceMs: 20,
      log: () => {},
    })
    try {
      await server.ready
      const first = server.version() as PreviewVersion
      expect(first.version).toMatch(/^dev-[a-z0-9]+-1$/)
      expect(first.entry).toBe("./app-one.js")
      expect(first.stateVersion).toBe("schema-1")
      const served = (await (await fetch(`${server.url}/version.json`)).json()) as PreviewVersion
      expect(served).toEqual(first)

      const live = follow(server)
      await until(() => live.snapshots.length > 0)
      expect(live.snapshots[0]).toMatchObject({
        dev: true,
        deployed: { version: first.version },
        build: { state: "deployed", version: first.version },
      })
      expect(server.connections()).toBe(1)

      writeFileSync(join(p.dir, "src", "app.txt"), "two")
      await until(() => live.snapshots.some((s) => s.deployed?.version !== first.version))
      const second = server.version() as PreviewVersion
      expect(second.version).toMatch(/-2$/)
      expect(second.entry).toBe("./app-two.js")
      expect(live.snapshots.some((s) => s.build?.state === "building")).toBe(true)
      expect(server.builds().at(-1)).toMatchObject({ ok: true, changed: [join("src", "app.txt")] })
      expect(await (await fetch(`${server.url}/app-two.js`)).text()).toBe(
        'export const value = "two"',
      )
      live.close()
      await until(() => server.connections() === 0)
    } finally {
      await server.close()
    }
  })

  test("a failed build is reported and keeps serving the last good one", async () => {
    const p = project()
    const server = await createPreviewDevServer({
      cwd: p.dir,
      outdir: "dist",
      build: p.build,
      watch: ["src"],
      debounceMs: 10_000,
      log: () => {},
    })
    try {
      await server.ready
      const good = server.version() as PreviewVersion
      writeFileSync(join(p.dir, "src", "app.txt"), "broken")
      const result = await server.rebuild()
      expect(result.ok).toBe(false)
      expect(result.error).toContain("syntax error")
      expect(server.version()).toEqual(good)
      const status = (await (
        await fetch(`${server.url}/__preview/status`)
      ).json()) as PreviewStatusSnapshot
      expect(status.build).toMatchObject({ state: "failed", message: "syntax error in app.txt" })
      expect(status.deployed?.version).toBe(good.version)
    } finally {
      await server.close()
    }
  })

  test("runs a build command, and reports its exit code and output", async () => {
    const p = project()
    writeFileSync(
      join(p.dir, "build.ts"),
      `import { writeFileSync } from "node:fs"
if (process.env.FAIL_BUILD) { console.error("boom from the build"); process.exit(3) }
writeFileSync("dist/app-x.js", "export {}")
writeFileSync("dist/version.json", JSON.stringify({ version: "development", builtAt: "x", entry: "./app-x.js" }))
`,
    )
    const server = await createPreviewDevServer({
      cwd: p.dir,
      outdir: "dist",
      build: [process.execPath, "build.ts"],
      watch: ["src"],
      log: () => {},
    })
    try {
      await server.ready
      expect(server.version()?.entry).toBe("./app-x.js")
      expect(server.version()?.stateVersion).toBeUndefined()
      process.env.FAIL_BUILD = "1"
      const failed = await server.rebuild()
      expect(failed.ok).toBe(false)
      expect(failed.error).toContain("exited 3")
      expect(failed.error).toContain("boom from the build")
    } finally {
      delete process.env.FAIL_BUILD
      await server.close()
    }
  })

  test("serves files with revalidation, the SPA fallback, and nothing outside outdir", async () => {
    const p = project()
    const server = await createPreviewDevServer({
      cwd: p.dir,
      outdir: "dist",
      build: p.build,
      watch: ["src"],
      log: () => {},
    })
    try {
      await server.ready
      const asset = await fetch(`${server.url}/app-one.js`)
      expect(asset.headers.get("content-type")).toContain("text/javascript")
      expect(asset.headers.get("cache-control")).toBe("no-cache")
      const etag = asset.headers.get("etag") as string
      expect(
        (await fetch(`${server.url}/app-one.js`, { headers: { "if-none-match": etag } })).status,
      ).toBe(304)
      expect((await fetch(`${server.url}/version.json`)).headers.get("cache-control")).toBe(
        "no-store",
      )
      const deep = await fetch(`${server.url}/settings/profile`)
      expect(await deep.text()).toContain("<main id=preview>")
      expect((await fetch(`${server.url}/missing.js`)).status).toBe(404)
      expect((await server.fetch(new Request("http://x/%2e%2e/src/app.txt"))).status).toBe(404)
    } finally {
      await server.close()
    }
  })

  test("createLivePreview on the dev server is live and applies a build at once, keeping the tab's data", async () => {
    const p = project()
    const server = await createPreviewDevServer({
      cwd: p.dir,
      outdir: "dist",
      build: p.build,
      watch: ["src"],
      debounceMs: 20,
      log: () => {},
    })
    try {
      await server.ready
      const current = (await (await fetch(`${server.url}/version.json`)).json()) as PreviewVersion
      const loads: string[] = []
      const live = createLivePreview({
        current,
        origin: server.url,
        // A long countdown: a dev server's build must not wait for it.
        countdownMs: 60_000,
        EventSource: fetchEventSource(),
        fetch: ((input: string, init?: RequestInit) => fetch(input, init)) as typeof fetch,
        document: { addEventListener() {}, removeEventListener() {}, hidden: false },
        window: { addEventListener() {}, removeEventListener() {} },
        load: async (version) => {
          loads.push(version.entry)
          return () => {}
        },
      })
      await live.start()
      await until(() => live.get().connection === "live")

      writeFileSync(join(p.dir, "src", "app.txt"), "two")
      await until(() => loads.includes("./app-two.js"))
      expect(live.get().current.version).toBe((server.version() as PreviewVersion).version)

      // A new stateVersion resets the tab's data: offered, never applied on its own.
      writeFileSync(join(p.dir, "src", "state.txt"), "schema-2")
      writeFileSync(join(p.dir, "src", "app.txt"), "three")
      await until(() => live.get().update.resetsData === true)
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(loads).toEqual(["./app-one.js", "./app-two.js"])
      expect(live.get().update.autoApplyAt).toBeUndefined()
      live.close()
    } finally {
      await server.close()
    }
  })

  test("an unknown watch path fails before serving", async () => {
    const p = project()
    await expect(
      createPreviewDevServer({
        cwd: p.dir,
        outdir: "dist",
        build: p.build,
        watch: ["nope"],
        log: () => {},
      }),
    ).rejects.toThrow("does not exist")
  })
})

describe("mockingbird-preview dev", () => {
  test("serves until its signal, building with the command", async () => {
    const p = project()
    writeFileSync(
      join(p.dir, "build.ts"),
      `import { writeFileSync } from "node:fs"
writeFileSync(${JSON.stringify(join(p.dir, "dist", "app-c.js"))}, "export {}")
writeFileSync(${JSON.stringify(join(p.dir, "dist", "build.json"))}, JSON.stringify({ entry: "./app-c.js" }))
`,
    )
    const out: string[] = []
    const abort = new AbortController()
    const running = runPreviewCli(
      [
        "dev",
        "--outdir",
        join(p.dir, "dist"),
        "--build",
        `${process.execPath} ${join(p.dir, "build.ts")}`,
        "--watch",
        join(p.dir, "src"),
        "--port",
        "0",
        "--state-version",
        "v9",
      ],
      { stdout: (line) => out.push(line), stderr: (line) => out.push(line) },
      { env: {}, fetch: (input, init) => fetch(input, init), signal: abort.signal },
    )
    await until(() => out.some((line) => line.includes("built dev-")))
    const url = out.find((line) => line.includes("serving"))?.split("serving ")[1] as string
    const version = (await (await fetch(`${url}/version.json`)).json()) as PreviewVersion
    expect(version).toMatchObject({ entry: "./app-c.js", stateVersion: "v9" })
    abort.abort()
    expect(await running).toBe(0)
  })

  test("refuses a missing --watch", async () => {
    const err: string[] = []
    const code = await runPreviewCli(
      ["dev", "--outdir", "dist", "--build", "true"],
      { stdout: () => {}, stderr: (line) => err.push(line) },
      { env: {}, fetch: (input, init) => fetch(input, init) },
    )
    expect(code).toBe(1)
    expect(err[0]).toContain("--watch is required")
  })
})
