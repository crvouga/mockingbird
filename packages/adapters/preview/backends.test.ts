import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  backendControlHandler,
  backendControls,
  createBackendHost,
  importPreviewBackend,
  type PreviewBackendBoot,
  PreviewBackendDrainError,
  PreviewBackendUpdateError,
} from "./src/backends.js"
import { createPreviewHost } from "./src/host.js"

/** A backend that answers which generation served each request, and can be held open. */
const recording = (log: string[], options: { db?: Map<string, string>; label?: string } = {}) => {
  const gates = new Map<string, () => void>()
  const boot: PreviewBackendBoot = ({ id, generation }) => ({
    async fetch(request) {
      const url = new URL(request.url)
      const name = url.searchParams.get("name") ?? url.pathname
      if (url.searchParams.has("hold"))
        await new Promise<void>((resolve, reject) => {
          gates.set(name, resolve)
          request.signal.addEventListener("abort", () => reject(request.signal.reason), {
            once: true,
          })
        })
      if (options.db && request.method === "PUT")
        options.db.set(name, `${options.label ?? id}@${generation}`)
      log.push(`${name}->${options.label ?? id}@${generation}`)
      return Response.json({
        backend: id,
        generation,
        label: options.label,
        db: options.db?.get(name),
      })
    },
    dispose: () => void log.push(`dispose ${options.label ?? id}@${generation}`),
  })
  return { boot, release: (name: string) => gates.get(name)?.() }
}

const get = (path: string, init?: RequestInit) => new Request(`http://api.internal${path}`, init)

describe("#839 lazy backends", () => {
  test("4. a backend nobody called is not started; the first request boots it, queues and reports progress", async () => {
    let finishBoot: () => void = () => {}
    const progress: (number | undefined)[] = []
    const host = createBackendHost({
      backends: {
        api: {
          match: "api.internal",
          boot: async ({ progress: report }) => {
            report(0.4, "migrating")
            await new Promise<void>((resolve) => {
              finishBoot = resolve
            })
            return { fetch: () => new Response("ok") }
          },
        },
        stripe: {
          kind: "emulator",
          match: "/v1",
          boot: () => ({ fetch: () => new Response("s") }),
        },
      },
    })
    host.subscribe(() => progress.push(host.status()[0]?.progress?.fraction))
    expect(host.status().map((backend) => backend.state)).toEqual(["not started", "not started"])
    const first = host.fetch(get("/one"))
    const second = host.fetch(get("/two"))
    await Promise.resolve()
    expect(host.status()[0]).toMatchObject({
      state: "starting",
      progress: { fraction: 0.4, note: "migrating" },
    })
    expect(progress).toContain(0.4)
    finishBoot()
    expect(await (await first).text()).toBe("ok")
    expect(await (await second).text()).toBe("ok")
    expect(host.status().map((backend) => backend.state)).toEqual(["ready", "not started"])
    // An unknown host is a typed 404, not a boot.
    const missing = await host.fetch(new Request("http://elsewhere.internal/"))
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: "preview_backend_not_found" })
    await host.dispose()
  })

  test("a backend whose boot fails answers a typed 503 and boots again on the next request", async () => {
    let attempts = 0
    const host = createBackendHost({
      backends: {
        api: {
          match: "/",
          boot: () => {
            if (++attempts === 1) throw new Error("port in use")
            return { fetch: () => new Response("ok") }
          },
        },
      },
    })
    const failed = await host.fetch(get("/"))
    expect(failed.status).toBe(503)
    expect(await failed.json()).toEqual({
      error: "preview_backend_failed",
      backend: "api",
      message: "port in use",
    })
    expect(host.status()[0]).toMatchObject({ state: "failed", message: "port in use" })
    expect(await (await host.fetch(get("/"))).text()).toBe("ok")
    await host.dispose()
  })
})

describe("#838 per-backend swap", () => {
  test("2. requests started before the swap finish on the old handler; later ones go to the new one", async () => {
    const log: string[] = []
    const v1 = recording(log, { label: "v1" })
    const v2 = recording(log, { label: "v2" })
    const host = createBackendHost({ backends: { api: { match: "/", boot: v1.boot } } })
    await host.ensure(["api"])
    const before = host.fetch(get("/?name=before&hold"))
    await Bun.sleep(5)
    const swapped = host.replace("api", v2.boot, { drainMs: 1_000 })
    await Bun.sleep(5)
    const after = await host.fetch(get("/?name=after"))
    expect(await after.json()).toMatchObject({ label: "v2", generation: 1 })
    expect(host.status()[0]).toMatchObject({ state: "ready", generation: 1, inFlight: 1 })
    v1.release("before")
    expect(await (await before).json()).toMatchObject({ label: "v1", generation: 0 })
    await swapped
    expect(log).toEqual(["after->v2@1", "before->v1@0", "dispose v1@0"])
    await host.dispose()
  })

  test("2. after the drain deadline, the old generation's remaining requests get a typed error", async () => {
    const log: string[] = []
    const v1 = recording(log, { label: "v1" })
    const v2 = recording(log, { label: "v2" })
    const host = createBackendHost({ backends: { api: { match: "/", boot: v1.boot } } })
    await host.ensure(["api"])
    const stuck = host.fetch(get("/?name=stuck&hold"))
    await Bun.sleep(5)
    await host.replace("api", v2.boot, { drainMs: 20 })
    const error = await stuck.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(PreviewBackendDrainError)
    expect(error).toMatchObject({ code: "preview_backend_drained", backend: "api", generation: 0 })
    expect(log).toEqual(["dispose v1@0"])
    expect(host.status()[0]?.inFlight).toBe(0)
    await host.dispose()
  })

  test("2. a streamed body still being read keeps the old generation until it ends", async () => {
    let push: ((chunk: string) => void) | undefined
    let end: (() => void) | undefined
    const disposed: number[] = []
    const streaming: PreviewBackendBoot = ({ generation }) => ({
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              push = (chunk) => controller.enqueue(new TextEncoder().encode(chunk))
              end = () => controller.close()
            },
          }),
        ),
      dispose: () => void disposed.push(generation),
    })
    const host = createBackendHost({ backends: { api: { match: "/", boot: streaming } } })
    const response = await host.fetch(get("/stream"))
    const reader = response.body?.getReader()
    push?.("a")
    const swap = host.replace("api", streaming, { drainMs: 1_000 })
    await Bun.sleep(10)
    expect(disposed).toEqual([])
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("a")
    end?.()
    expect((await reader?.read())?.done).toBe(true)
    await swap
    expect(disposed).toEqual([0])
    await host.dispose()
  })

  test("3. when the new code fails to boot, the old one keeps serving and the error says why", async () => {
    const log: string[] = []
    const v1 = recording(log, { label: "v1" })
    const host = createBackendHost({ backends: { api: { match: "/", boot: v1.boot } } })
    await host.ensure(["api"])
    const failure = await host
      .replace("api", () => {
        throw new Error("SyntaxError in api-222.js")
      })
      .catch((caught: unknown) => caught)
    expect(failure).toBeInstanceOf(PreviewBackendUpdateError)
    expect((failure as Error).message).toBe(
      "Backend api failed to boot its new code: SyntaxError in api-222.js",
    )
    expect(host.status()[0]).toMatchObject({
      state: "ready",
      generation: 0,
      message: "SyntaxError in api-222.js",
    })
    expect(await (await host.fetch(get("/?name=still"))).json()).toMatchObject({ label: "v1" })
    // A retry with working code succeeds.
    await host.replace("api", recording(log, { label: "v3" }).boot)
    expect(await (await host.fetch(get("/?name=retried"))).json()).toMatchObject({ label: "v3" })
    await host.dispose()
  })

  test("4. emulator and database state from before the swap is there after it, with no export or import", async () => {
    const db = new Map<string, string>()
    const log: string[] = []
    const emulatorCharges: string[] = []
    const host = createBackendHost({
      backends: {
        stripe: {
          kind: "emulator",
          match: "stripe.internal",
          boot: () => ({
            async fetch(request) {
              if (request.method === "POST") emulatorCharges.push(await request.text())
              return Response.json({ charges: emulatorCharges })
            },
          }),
        },
        api: { match: "api.internal", boot: recording(log, { db, label: "v1" }).boot },
      },
    })
    await (await host.fetch(get("/?name=patient-1", { method: "PUT" }))).json()
    await (
      await host.fetch(
        new Request("http://stripe.internal/v1/charges", { method: "POST", body: "ch_1" }),
      )
    ).json()
    await host.replace("api", recording(log, { db, label: "v2" }).boot)
    expect(await (await host.fetch(get("/?name=patient-1"))).json()).toMatchObject({
      label: "v2",
      db: "v1@0",
    })
    expect(
      await (await host.fetch(new Request("http://stripe.internal/v1/charges"))).json(),
    ).toEqual({ charges: ["ch_1"] })
    expect(host.status().map(({ id, generation }) => [id, generation])).toEqual([
      ["stripe", 0],
      ["api", 1],
    ])
    await host.dispose()
  })

  test("a backend that never started just takes the new code for its first boot", async () => {
    const log: string[] = []
    const host = createBackendHost({
      backends: { api: { match: "/", boot: recording(log, { label: "v1" }).boot } },
    })
    await host.replace("api", recording(log, { label: "v2" }).boot)
    expect(host.status()[0]?.state).toBe("not started")
    expect(await (await host.fetch(get("/?name=x"))).json()).toMatchObject({
      label: "v2",
      generation: 0,
    })
    await host.dispose()
  })

  test("the control routes boot and swap backends for a tab, and refuse a swap they cannot import", async () => {
    const log: string[] = []
    const backends = createBackendHost({
      backends: { api: { match: "api.internal", boot: recording(log, { label: "v1" }).boot } },
    })
    const control = backendControlHandler(backends, {
      importBackend: async (entry) => recording(log, { label: entry }).boot,
    })
    const preview = createPreviewHost({
      artifact: "backends",
      boot: () => ({
        fetch: (request) => control(request) ?? backends.fetch(request),
        dispose: backends.dispose,
      }),
    })
    const controls = backendControls(preview.fetch)
    expect((await controls.list()).map((backend) => backend.state)).toEqual(["not started"])
    await controls.ensure(["api"])
    expect((await controls.list())[0]?.state).toBe("ready")
    await controls.replace("api", { entry: "./backends/api-222.js" })
    expect(await (await preview.fetch(get("/?name=x"))).json()).toMatchObject({
      label: "./backends/api-222.js",
    })
    const refusing = backendControlHandler(backends)
    const refused = await refusing(
      new Request("http://preview.local/__preview/backends", {
        method: "POST",
        body: JSON.stringify({ replace: "api", entry: "./x.js" }),
      }),
    )
    expect(refused?.status).toBe(501)
    expect(await refused?.json()).toMatchObject({ error: "preview_backend_replace_unsupported" })
    await preview.dispose()
  })
})

describe("#899 replace one app server inside a running system", () => {
  const dir = mkdtempSync(join(tmpdir(), "mockingbird-backend-modules-"))
  let modules = 0
  /** Writes an app-server module (loaded by URL, as the worker would) and returns its URL. */
  const serverModule = (label: string, options: { bootMs?: number; fail?: boolean } = {}) => {
    const file = join(dir, `server-${++modules}.mjs`)
    writeFileSync(
      file,
      `export async function boot({ id, generation }) {
  const log = globalThis.__systemLog
  log.push("boot ${label}")
  ${options.bootMs ? `await new Promise((r) => setTimeout(r, ${options.bootMs}))` : ""}
  ${options.fail ? `throw new Error("${label} does not compile")` : ""}
  return {
    async fetch(request) {
      const url = new URL(request.url)
      if (url.searchParams.has("hold")) await new Promise((r) => (globalThis.__release = r))
      // The database is a long-lived service of the same system, reached through it.
      const db = await globalThis.__system.fetch(new Request("http://db.internal/" + url.pathname.slice(1)))
      return Response.json({ server: "${label}", generation, db: await db.text() })
    },
    dispose() { log.push("dispose ${label}") },
  }
}
`,
    )
    return pathToFileURL(file).href
  }

  /** A system: a database emulator, a backend and an admin server with in-memory state. */
  const system = (api: string, options: Parameters<typeof createBackendHost>[0]["strategy"]) => {
    const log: string[] = []
    const rows = new Map<string, string>([["users", "ada,grace"]])
    let adminHits = 0
    let adminBoots = 0
    let dbBoots = 0
    ;(globalThis as Record<string, unknown>).__systemLog = log
    const host = createBackendHost({
      ...(options ? { strategy: options } : {}),
      backends: {
        db: {
          kind: "emulator",
          match: "db.internal",
          boot: () => {
            dbBoots++
            return {
              fetch: (request) =>
                new Response(rows.get(new URL(request.url).pathname.slice(1)) ?? ""),
            }
          },
        },
        // The app server's first code, loaded by URL like every later one.
        backend: {
          match: "api.internal",
          boot: async (context) => (await importPreviewBackend(api))(context),
        },
        admin: {
          match: "admin.internal",
          boot: () => {
            adminBoots++
            return { fetch: () => Response.json({ hits: ++adminHits }) }
          },
        },
      },
    })
    ;(globalThis as Record<string, unknown>).__system = host
    return { host, log, rows, adminBoots: () => adminBoots, dbBoots: () => dbBoots }
  }
  const updating = async (host: ReturnType<typeof createBackendHost>) => {
    while (host.status().find((b) => b.id === "backend")?.state !== "updating")
      await new Promise((r) => setTimeout(r, 1))
  }
  const call = async (host: ReturnType<typeof createBackendHost>, url: string) =>
    (await (await host.fetch(new Request(url))).json()) as Record<string, unknown>

  test("acceptance: replacing `backend` by URL leaves the database, the admin server and their state untouched", async () => {
    const s = system(serverModule("v1"), undefined)
    const backend = s.host
    expect(await call(backend, "http://api.internal/users")).toEqual({
      server: "v1",
      generation: 0,
      db: "ada,grace",
    })
    expect(await call(backend, "http://admin.internal/")).toEqual({ hits: 1 })
    s.rows.set("users", "ada,grace,linus")

    const inFlight = backend.fetch(new Request("http://api.internal/users?hold"))
    await new Promise((r) => setTimeout(r, 5))
    const swap = backend.replace("backend", serverModule("v2", { bootMs: 20 }))
    // While v2 boots, v1 keeps answering.
    expect((await call(backend, "http://api.internal/users")).server).toBe("v1")
    while (backend.status().find((b) => b.id === "backend")?.generation !== 1)
      await new Promise((r) => setTimeout(r, 2))
    expect(await call(backend, "http://api.internal/users")).toEqual({
      server: "v2",
      generation: 1,
      db: "ada,grace,linus",
    })
    ;(globalThis as { __release?: () => void }).__release?.()
    expect(((await (await inFlight).json()) as { server: string }).server).toBe("v1")
    await swap
    // The admin server kept its in-memory state and was never booted again; nor was the database.
    expect(await call(backend, "http://admin.internal/")).toEqual({ hits: 2 })
    expect(s.adminBoots()).toBe(1)
    expect(s.dbBoots()).toBe(1)
    expect(
      backend.status().map(({ id, state, generation }) => ({ id, state, generation })),
    ).toEqual([
      { id: "db", state: "ready", generation: 0 },
      { id: "backend", state: "ready", generation: 1 },
      { id: "admin", state: "ready", generation: 0 },
    ])
    expect(s.log).toContain("dispose v1")
    await backend.dispose()
  })

  test("stop-first: requests to the server being replaced wait for the new code instead of failing", async () => {
    const s = system(serverModule("v1"), "stop-first")
    await s.host.ensure(["backend", "admin"])
    const inFlight = s.host.fetch(new Request("http://api.internal/users?hold"))
    await new Promise((r) => setTimeout(r, 5))
    const swap = s.host.replace("backend", serverModule("v2", { bootMs: 30 }))
    await updating(s.host)
    // Arrives mid-swap: waits, and the admin server answers meanwhile.
    const waiting = s.host.fetch(new Request("http://api.internal/users"))
    expect(await call(s.host, "http://admin.internal/")).toEqual({ hits: 1 })
    ;(globalThis as { __release?: () => void }).__release?.()
    expect(((await (await inFlight).json()) as { server: string }).server).toBe("v1")
    await swap
    const waited = await waiting
    expect(waited.status).toBe(200)
    expect(((await waited.json()) as { server: string }).server).toBe("v2")
    // The old server was gone before the new one booted.
    expect(s.log.indexOf("dispose v1")).toBeLessThan(s.log.lastIndexOf("boot v2"))
    expect(s.adminBoots()).toBe(1)
    await s.host.dispose()
  })

  test("stop-first: new code that fails to boot brings the old code back for the waiting requests", async () => {
    const s = system(serverModule("v1"), "stop-first")
    await s.host.ensure(["backend"])
    const swap = s.host.replace("backend", serverModule("v2", { bootMs: 30, fail: true }))
    await updating(s.host)
    const waiting = s.host.fetch(new Request("http://api.internal/users"))
    await expect(swap).rejects.toBeInstanceOf(PreviewBackendUpdateError)
    expect(((await (await waiting).json()) as { server: string }).server).toBe("v1")
    expect(s.host.status().find((b) => b.id === "backend")).toMatchObject({
      state: "ready",
      message: "v2 does not compile",
    })
    await s.host.dispose()
  })

  test("a module URL that exports no boot is refused and the running code keeps serving", async () => {
    const s = system(serverModule("v1"), undefined)
    const file = join(dir, "not-a-server.mjs")
    writeFileSync(file, "export const value = 1\n")
    await expect(s.host.replace("backend", pathToFileURL(file).href)).rejects.toThrow(
      "exports no backend boot",
    )
    expect((await call(s.host, "http://api.internal/users")).server).toBe("v1")
    await s.host.dispose()
  })
})
