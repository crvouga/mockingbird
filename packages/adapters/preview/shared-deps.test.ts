import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  buildPreviewPartSet,
  PREVIEW_SHARED_DEPS_PART,
  watchPreviewParts,
} from "./src/parts-build.js"
import { formatPartSizes, type PreviewLoadManifest } from "./src/parts-load.js"

const root = mkdtempSync(join(tmpdir(), "mockingbird-preview-shared-deps-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** Two app servers over an ES module dependency and a CommonJS one, each with module state. */
const fixture = (name: string) => {
  const dir = join(root, name)
  const pkg = (id: string, files: Record<string, string>) => {
    mkdirSync(join(dir, "node_modules", id), { recursive: true })
    for (const [file, text] of Object.entries(files))
      writeFileSync(join(dir, "node_modules", id, file), text)
  }
  pkg("esm-lib", {
    "package.json": JSON.stringify({ name: "esm-lib", type: "module", main: "index.js" }),
    "index.js": `let count = 0\nexport const next = () => ++count\nexport const greet = (who) => "hello from esm-lib, " + who\nexport default "esm-default"\n`,
  })
  pkg("cjs-lib", {
    "package.json": JSON.stringify({ name: "cjs-lib", main: "index.js" }),
    "index.js": `let n = 0\nexports.bump = () => ++n\nexports.add = (a, b) => a + b + 0 /* cjs-lib-marker */\n`,
  })
  pkg("late-lib", {
    "package.json": JSON.stringify({ name: "late-lib", type: "module", main: "index.js" }),
    "index.js": `export const late = () => "late-lib"\n`,
  })
  for (const server of ["api", "admin"]) mkdirSync(join(dir, server), { recursive: true })
  writeFileSync(
    join(dir, "api", "server.ts"),
    `import greetDefault, { greet, next } from "esm-lib"\nimport { add, bump } from "cjs-lib"\nexport const run = () => ({ server: "api v1", greet: greet("api"), greetDefault, next: next(), bump: bump(), sum: add(1, 2) })\n`,
  )
  writeFileSync(
    join(dir, "admin", "server.ts"),
    `import { next } from "esm-lib"\nimport cjs from "cjs-lib"\nconst required = require("esm-lib")\nexport const run = () => ({ server: "admin", next: next(), bump: cjs.bump(), required: required.greet("admin") })\n`,
  )
  return dir
}

const options = (dir: string) => ({
  parts: [],
  backends: { api: "api/server.ts", admin: "admin/server.ts" },
  outdir: "out",
  workingDir: dir,
  runtime: "rt",
  dependencies: "shared" as const,
  log: () => {},
})

let imports = 0
/** Loads a built backend by its URL, as the worker does (a fresh query keeps Bun's cache apart). */
const load = async (dir: string, entry: string) =>
  (await import(`${pathToFileURL(join(dir, "out", entry)).href}?i=${++imports}`)) as {
    run(): Record<string, unknown>
  }

describe('#899 dependencies: "shared"', () => {
  test("node_modules code goes to one dependency part every server imports by URL, sharing its state", async () => {
    const dir = fixture("build")
    const { manifest, parts } = await buildPreviewPartSet(options(dir))
    const deps = manifest.dependencies
    expect(deps?.entry).toBe(`./parts/${PREVIEW_SHARED_DEPS_PART}/${deps?.pin}/`)
    expect(parts.map((part) => part.app).sort()).toEqual([
      "backend-admin",
      "backend-api",
      PREVIEW_SHARED_DEPS_PART,
    ])
    const files = readdirSync(join(dir, "out", "parts", PREVIEW_SHARED_DEPS_PART, deps?.pin ?? ""))
    expect(files).toContain("part.json")

    // The servers' own parts hold only their own code.
    const api = manifest.backends?.api?.entry as string
    const apiCode = readFileSync(join(dir, "out", api), "utf8")
    expect(apiCode).not.toContain("hello from esm-lib")
    expect(apiCode).not.toContain("cjs-lib-marker")
    expect(apiCode).toContain(`../../${PREVIEW_SHARED_DEPS_PART}/${deps?.pin}/`)

    // Both load by URL; module state (an ES module's and a CommonJS module's) is shared by both.
    const apiServer = await load(dir, api)
    const adminServer = await load(dir, manifest.backends?.admin?.entry as string)
    expect(apiServer.run()).toEqual({
      server: "api v1",
      greet: "hello from esm-lib, api",
      greetDefault: "esm-default",
      next: 1,
      bump: 1,
      sum: 3,
    })
    expect(adminServer.run()).toEqual({
      server: "admin",
      next: 2,
      bump: 2,
      required: "hello from esm-lib, admin",
    })
    expect(formatPartSizes(manifest)).toContain("(dependencies)")
  })

  test('"bundle" (the default) puts dependencies into each part, as before', async () => {
    const dir = fixture("bundled")
    const { manifest } = await buildPreviewPartSet({ ...options(dir), dependencies: "bundle" })
    expect(manifest.dependencies).toBeUndefined()
    const apiCode = readFileSync(join(dir, "out", manifest.backends?.api?.entry as string), "utf8")
    expect(apiCode).toContain("hello from esm-lib")
  })

  test("the dev loop rebuilds only the edited server; a new dependency moves every part to a new dependency part", async () => {
    const dir = fixture("watch")
    const watcher = watchPreviewParts({ ...options(dir), debounceMs: 30 })
    try {
      const first = await watcher.ready
      const updates: PreviewLoadManifest[] = []
      watcher.subscribe((manifest) => updates.push(manifest))
      writeFileSync(
        join(dir, "api", "server.ts"),
        `import { greet } from "esm-lib"\nexport const run = () => ({ server: "api v2", greet: greet("api") })\n`,
      )
      const started = Date.now()
      while (updates.length === 0 && Date.now() - started < 4_000) await Bun.sleep(20)
      const second = updates[0] as PreviewLoadManifest
      expect(watcher.rebuilds()).toEqual([{ parts: ["backend:api"] }])
      expect(second.dependencies).toEqual(
        first.dependencies as NonNullable<typeof first.dependencies>,
      )
      expect(second.backends?.admin).toEqual(
        first.backends?.admin as NonNullable<typeof first.backends>[string],
      )
      expect(second.backends?.api?.pin).not.toBe(first.backends?.api?.pin)
      expect((await load(dir, second.backends?.api?.entry as string)).run()).toEqual({
        server: "api v2",
        greet: "hello from esm-lib, api",
      })

      writeFileSync(
        join(dir, "api", "server.ts"),
        `import { late } from "late-lib"\nexport const run = () => ({ server: "api v3", late: late() })\n`,
      )
      const seen = updates.length
      const again = Date.now()
      while (updates.length === seen && Date.now() - again < 4_000) await Bun.sleep(20)
      const third = updates.at(-1) as PreviewLoadManifest
      expect(third.dependencies?.pin).not.toBe(first.dependencies?.pin)
      expect(third.backends?.admin?.pin).not.toBe(first.backends?.admin?.pin)
      expect((await load(dir, third.backends?.api?.entry as string)).run()).toEqual({
        server: "api v3",
        late: "late-lib",
      })
      expect((await load(dir, third.backends?.admin?.entry as string)).run()).toMatchObject({
        server: "admin",
      })
    } finally {
      watcher.close()
    }
  })

  test(`a part named ${PREVIEW_SHARED_DEPS_PART} is refused`, async () => {
    const dir = fixture("reserved")
    await expect(
      buildPreviewPartSet({
        ...options(dir),
        parts: [{ id: PREVIEW_SHARED_DEPS_PART, source: "api/server.ts" }],
      }),
    ).rejects.toThrow("reserved")
  })
})
