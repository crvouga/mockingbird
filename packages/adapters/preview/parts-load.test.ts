import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PreviewDownload } from "./src/artifacts.js"
import { servePreviewPort } from "./src/bridge.js"
import { createPreviewPartsManifest, loadPreviewPart, planPreviewParts } from "./src/parts.js"
import { buildPreviewPartSet, buildPreviewParts, watchPreviewParts } from "./src/parts-build.js"
import {
  checkPartBudgets,
  followPartUpdates,
  formatPartSizes,
  gzipSize,
  type PreviewLoadManifest,
  PreviewPartBudgetError,
  parsePreviewLoadManifest,
  partUpdatesResponse,
} from "./src/parts-load.js"
import { acceptPreviewFrame } from "./src/worker-connect.js"

const root = mkdtempSync(join(tmpdir(), "mockingbird-preview-parts-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** The three-app example: each app in its own directory, plus a module both share. */
const fixture = (name: string) => {
  const dir = join(root, name)
  for (const app of ["member", "clinician", "partner", "shared"])
    mkdirSync(join(dir, app), { recursive: true })
  writeFileSync(join(dir, "shared", "theme.ts"), `export const theme = "teal"\n`)
  writeFileSync(
    join(dir, "member", "app.ts"),
    `import { theme } from "../shared/theme.ts"\nexport const mount = (host: HTMLElement) => { host.textContent = "member " + theme; return () => {} }\n`,
  )
  writeFileSync(
    join(dir, "clinician", "app.ts"),
    `export const mount = (host: HTMLElement) => { host.textContent = "clinician v1"; return () => {} }\n`,
  )
  writeFileSync(
    join(dir, "partner", "app.ts"),
    `import { theme } from "../shared/theme.ts"\ndocument.body.textContent = "partner " + theme\n`,
  )
  return dir
}
const PARTS = [
  { id: "member", source: "member/app.ts", backends: ["api"] },
  { id: "clinician", source: "clinician/app.ts", prefetch: true },
  { id: "partner", mount: "iframe" as const, source: "partner/app.ts" },
]

describe("#841 the build produces each declared app's part", () => {
  test("1. every app in the registry gets a pinned part and a manifest entry", async () => {
    const dir = fixture("build")
    const tables: string[] = []
    const manifest = await buildPreviewParts({
      parts: PARTS,
      outdir: "out",
      workingDir: dir,
      runtime: "rt-1",
      log: (table) => tables.push(table),
    })
    expect(Object.keys(manifest.parts)).toEqual(["member", "clinician", "partner"])
    expect(manifest.parts.member).toMatchObject({ backends: ["api"] })
    expect(manifest.parts.member?.entry).toBe(
      `./parts/member/${manifest.parts.member?.pin}/index.js`,
    )
    expect(manifest.parts.member?.pin).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.parts.clinician).toMatchObject({ prefetch: true })
    expect(manifest.parts.partner?.entry).toBe(
      `./parts/partner/${manifest.parts.partner?.pin}/index.html`,
    )
    expect(
      parsePreviewLoadManifest(JSON.parse(readFileSync(join(dir, "out", "parts.json"), "utf8"))),
    ).toEqual(manifest)
    const member = readFileSync(join(dir, "out", manifest.parts.member?.entry ?? ""), "utf8")
    expect(member).toContain("teal")
    expect(tables[0]).toContain("member")
    // Rebuilding the same sources yields the same pins: parts are content addressed.
    const again = await buildPreviewParts({
      parts: PARTS,
      outdir: "out",
      workingDir: dir,
      runtime: "rt-1",
      log: () => {},
    })
    expect(again).toEqual(manifest)
  })

  test("the built parts are the content-addressed parts a deploy shares and the shell verifies", async () => {
    const dir = fixture("shared")
    const build = () =>
      buildPreviewPartSet({
        parts: PARTS,
        outdir: "out",
        workingDir: dir,
        runtime: "rt-1",
        log: () => {},
      })
    const first = await build()
    expect(first.parts.map((part) => part.app).sort()).toEqual(["clinician", "member", "partner"])
    for (const part of first.parts) expect(first.manifest.parts[part.app]?.pin).toBe(part.pin)
    const base = createPreviewPartsManifest({
      commit: "base",
      parts: Object.fromEntries(first.parts.map((part) => [part.app, part])),
    })

    // The shell loads a part from the build output and verifies it against its pin.
    const local: PreviewDownload = async (input) =>
      new Response(readFileSync(join(dir, "out", new URL(String(input)).pathname)))
    const loaded = await loadPreviewPart(base, "partner", {
      baseUrl: "https://preview.example/",
      fetch: local,
    })
    expect([...loaded.files.keys()].sort()).toEqual(["index.html", "index.js"])

    // Changing one app changes only its input hash and pin, so the next commit builds only it.
    writeFileSync(
      join(dir, "clinician", "app.ts"),
      `export const mount = (host: HTMLElement) => { host.textContent = "clinician v2"; return () => {} }\n`,
    )
    const next = await build()
    const candidate = Object.fromEntries(next.parts.map((part) => [part.app, part.input]))
    const plan = planPreviewParts({ base, candidate, hosted: first.parts })
    expect(plan.build).toEqual(["clinician"])
    expect(plan.parts.member).toEqual(base.parts.member as NonNullable<typeof base.parts.member>)
  })
})

describe("#839 budgets", () => {
  test("7. a part over its compressed budget fails the build, naming the part and its size", async () => {
    const dir = fixture("budget")
    writeFileSync(
      join(dir, "clinician", "app.ts"),
      `export const mount = (host: HTMLElement) => { host.textContent = ${JSON.stringify(
        Array.from({ length: 4000 }, (_, index) => (index * 7919).toString(36)).join(" "),
      )}; return () => {} }\n`,
    )
    const error = await buildPreviewParts({
      parts: PARTS,
      outdir: "out",
      workingDir: dir,
      runtime: "rt-1",
      budgets: { part: 2048, parts: { clinician: 4096 } },
      log: () => {},
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(PreviewPartBudgetError)
    const over = (error as PreviewPartBudgetError).over
    expect(over.map((entry) => [entry.name, entry.budget])).toEqual([["clinician", 4096]])
    expect((error as Error).message).toMatch(/clinician is \d+\.\d KiB gzip, budget 4\.0 KiB/)
    expect((error as Error).message).toContain("OVER")
  })

  test("the shell's initial payload has its own budget, and the table lists every part", () => {
    const manifest: PreviewLoadManifest = {
      version: 1,
      runtime: "rt",
      shellBytes: 300_000,
      parts: { app: { entry: "./a.js", pin: "a", bytes: 1024 } },
      backends: { api: { entry: "./b.js", pin: "b", bytes: 2048 } },
    }
    expect(() => checkPartBudgets(manifest, { shell: 200_000 })).toThrow(
      /shell is 293\.0 KiB gzip, budget 195\.3 KiB/,
    )
    expect(() => checkPartBudgets(manifest, { shell: 400_000, part: 4096 })).not.toThrow()
    expect(formatPartSizes(manifest, { part: 1500 }).split("\n")).toEqual([
      "part              gzip   budget",
      "(shell)      293.0 KiB        -",
      "app            1.0 KiB  1.5 KiB",
      "backend:api    2.0 KiB  1.5 KiB  OVER",
    ])
  })

  test("gzip sizes are measured on the compressed bytes", async () => {
    const repetitive = "a".repeat(100_000)
    expect(await gzipSize(repetitive)).toBeLessThan(1_000)
  })

  test("a malformed manifest is refused, naming the field", () => {
    expect(() => parsePreviewLoadManifest({ version: 2 })).toThrow("version must be 1")
    expect(() =>
      parsePreviewLoadManifest({ version: 1, runtime: "r", parts: { app: { entry: "./a.js" } } }),
    ).toThrow("part app needs entry, pin and bytes")
  })
})

describe("#838 the dev loop", () => {
  test("6. changing one app's source rebuilds only that app's part and publishes it within seconds", async () => {
    const dir = fixture("watch")
    const watcher = watchPreviewParts({
      parts: PARTS,
      outdir: "out",
      workingDir: dir,
      runtime: "rt-1",
      debounceMs: 50,
      log: () => {},
    })
    try {
      const first = await watcher.ready
      const updates: PreviewLoadManifest[] = []
      watcher.subscribe((manifest) => updates.push(manifest))
      const started = Date.now()
      writeFileSync(
        join(dir, "clinician", "app.ts"),
        `export const mount = (host: HTMLElement) => { host.textContent = "clinician v2"; return () => {} }\n`,
      )
      while (updates.length === 0 && Date.now() - started < 4_000) await Bun.sleep(25)
      expect(Date.now() - started).toBeLessThan(4_000)
      expect(watcher.rebuilds()).toEqual([{ parts: ["clinician"] }])
      const next = updates[0] as PreviewLoadManifest
      expect(next.parts.clinician?.pin).not.toBe(first.parts.clinician?.pin)
      expect(next.parts.member).toEqual(
        first.parts.member as NonNullable<typeof first.parts.member>,
      )
      expect(next.parts.partner).toEqual(
        first.parts.partner as NonNullable<typeof first.parts.partner>,
      )
      expect(next.runtime).toBe(first.runtime)

      // A file two apps import rebuilds both of them, and only them.
      writeFileSync(join(dir, "shared", "theme.ts"), `export const theme = "plum"\n`)
      const seen = updates.length
      const again = Date.now()
      while (updates.length === seen && Date.now() - again < 4_000) await Bun.sleep(25)
      expect(watcher.rebuilds().at(-1)).toEqual({ parts: ["member", "partner"] })
    } finally {
      watcher.close()
    }
  })

  test("each manifest reaches the tab over Server-Sent Events, in order", async () => {
    const manifest = (pin: string): PreviewLoadManifest => ({
      version: 1,
      runtime: "rt",
      parts: { app: { entry: `./app-${pin}.js`, pin, bytes: 1 } },
    })
    let publish: ((manifest: PreviewLoadManifest) => void) | undefined
    const abort = new AbortController()
    const response = partUpdatesResponse(
      {
        manifest: () => manifest("a"),
        subscribe(listener) {
          publish = listener
          return () => {
            publish = undefined
          }
        },
      },
      abort.signal,
    )
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    publish?.(manifest("b"))
    abort.abort()
    const text = await response.text()
    expect(text.split("\n\n").filter(Boolean)).toEqual([
      `event: parts\ndata: ${JSON.stringify(manifest("a"))}`,
      `event: parts\ndata: ${JSON.stringify(manifest("b"))}`,
    ])

    // The tab side applies each manifest after the previous one settles.
    const listeners = new Map<string, (event: MessageEvent<string>) => void>()
    let closed = false
    class FakeEventSource {
      addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
        listeners.set(type, listener)
      }
      removeEventListener(type: string) {
        listeners.delete(type)
      }
      close() {
        closed = true
      }
    }
    const applied: string[] = []
    const stop = followPartUpdates(
      "/__preview/parts",
      async (next) => {
        await Bun.sleep(5)
        applied.push(next.parts.app?.pin ?? "")
      },
      { EventSource: FakeEventSource as unknown as new (url: string) => EventSource },
    )
    const send = (data: string) => listeners.get("parts")?.(new MessageEvent("parts", { data }))
    send(JSON.stringify(manifest("a")))
    send("not json")
    send(JSON.stringify(manifest("b")))
    await Bun.sleep(30)
    expect(applied).toEqual(["a", "b"])
    stop()
    expect(closed).toBe(true)
  })
})

describe("#841 iframe apps share the bridge", () => {
  test("6. an iframe app receives a port from its parent and fetches the same backends through it", async () => {
    const listeners = new Set<(event: MessageEvent) => void>()
    const scope = {
      addEventListener: (_: string, listener: (event: MessageEvent) => void) =>
        listeners.add(listener),
      removeEventListener: (_: string, listener: (event: MessageEvent) => void) =>
        listeners.delete(listener),
    }
    const parent = { name: "shell" }
    const accepted = acceptPreviewFrame({ scope, parent })
    const channel = new MessageChannel()
    const served = servePreviewPort(channel.port1, (request) =>
      Response.json({ path: new URL(request.url).pathname, from: "shared backend" }),
    )
    // A message from anything but the parent is ignored.
    for (const listener of listeners)
      listener({
        data: { type: "mockingbird-preview-connect", app: "evil" },
        ports: [new MessageChannel().port2],
        source: {},
        origin: "https://preview.example",
      } as unknown as MessageEvent)
    for (const listener of [...listeners])
      listener({
        data: { type: "mockingbird-preview-connect", app: "partner", path: "/partner/orders" },
        ports: [channel.port2],
        source: parent,
        origin: "https://preview.example",
      } as unknown as MessageEvent)
    const frame = await accepted
    expect(frame.app).toBe("partner")
    expect(frame.path).toBe("/partner/orders")
    const response = await frame.fetch(new Request("http://api.internal/orders"))
    expect(await response.json()).toEqual({ path: "/orders", from: "shared backend" })
    frame.dispose()
    served.dispose()
  })
})
