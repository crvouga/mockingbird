/**
 * The admin page's browser client (~1.3 MB) stays out of every service entry's static import
 * graph (#699, #707): a service bundle emits it as `dist/admin-ui.js`, loads it with a dynamic
 * import on the first `/__admin/ui` request, and an app bundle can split it off or leave it out.
 * Bundles the real runtime (`@crvouga/mockingbird-service`, built) the way bundle-service.ts does.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build } from "esbuild"
import { ADMIN_CLIENT_ENTRY, ADMIN_CLIENT_MODULE, bundleServiceJs } from "./bundle-service-js.ts"

const runtimeEntry = join(import.meta.dir, "..", "packages", "service", "core", "dist", "index.js")
const NOTICE = "Bundled third-party notices"
const ADMIN_STRING = "ADMIN_BROWSER_BUNDLE"

const work = mkdtempSync(join(tmpdir(), "bundle-service-js-"))
afterAll(() => rmSync(work, { recursive: true, force: true }))

/** A minimal service package: one portable entry built on the shared runtime. */
const fixture = (name: string, source: string) => {
  const dir = join(work, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, "src"), { recursive: true })
  writeFileSync(join(dir, "src", "index.js"), source)
  return dir
}

const SERVICE = `import { createRuntime as runtime } from ${JSON.stringify(runtimeEntry)}
export const createRuntime = () =>
  runtime({
    name: "fixture",
    create: () => ({ fetch: async () => new Response("ok"), reset: async () => {} }),
  })
`

const jsFiles = (dir: string) => readdirSync(dir).filter((file) => file.endsWith(".js"))
/** Relative static imports of a built file. */
const staticImports = (code: string) =>
  [
    ...code.matchAll(/^(?:import|export)\b[^;]*?from\s*"(\.\/[^"]+)"|^import\s*"(\.\/[^"]+)"/gm),
  ].map((m) => (m[1] ?? m[2]) as string)
const staticGraph = (dist: string, entry: string): Set<string> => {
  const seen = new Set<string>()
  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    for (const next of staticImports(readFileSync(join(dist, file), "utf8")))
      visit(next.replace(/^\.\//, ""))
  }
  visit(entry)
  return seen
}

describe("bundleServiceJs keeps the admin client lazy", () => {
  const pkg = fixture("service", SERVICE)
  const dist = join(pkg, "dist")
  beforeAll(async () => {
    await bundleServiceJs({
      absWorkingDir: pkg,
      entryPoints: { index: "src/index.js" },
      outdir: "dist",
      platform: "neutral",
    })
  })

  test("the client is emitted once, as dist/admin-ui.js", () => {
    const holders = jsFiles(dist).filter((file) =>
      readFileSync(join(dist, file), "utf8").includes(ADMIN_STRING),
    )
    expect(holders).toEqual([`${ADMIN_CLIENT_ENTRY}.js`])
  })

  test("no file the entry imports statically holds it; the runtime imports it dynamically", () => {
    const graph = staticGraph(dist, "index.js")
    expect(graph.has(`${ADMIN_CLIENT_ENTRY}.js`)).toBe(false)
    for (const file of graph)
      expect(readFileSync(join(dist, file), "utf8").includes(NOTICE)).toBe(false)
    const loaders = jsFiles(dist).filter((file) =>
      readFileSync(join(dist, file), "utf8").includes(`import("./${ADMIN_CLIENT_ENTRY}.js")`),
    )
    expect(loaders.length).toBe(1)
    expect(graph.has(loaders[0] as string)).toBe(true)
  })

  test("the built service serves the admin page through the sibling file", async () => {
    const { createRuntime } = (await import(join(dist, "index.js"))) as {
      createRuntime: () => { fetch(request: Request): Promise<Response> }
    }
    const runtime = createRuntime()
    expect((await runtime.fetch(new Request("http://x/__admin/health"))).status).toBe(200)
    const page = await runtime.fetch(new Request("http://x/__admin/ui"))
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain("MockingbirdAdmin.mount(")
    expect(html).toContain(NOTICE)
  })

  test("an app bundler that splits code keeps the client out of its main chunk", async () => {
    const app = join(work, "app.js")
    writeFileSync(app, `export { createRuntime } from ${JSON.stringify(join(dist, "index.js"))}\n`)
    const result = await build({
      entryPoints: [app],
      bundle: true,
      write: false,
      splitting: true,
      format: "esm",
      platform: "browser",
      outdir: join(work, "app-split"),
      logLevel: "silent",
    })
    const main = result.outputFiles.find((file) => file.path.endsWith("app.js"))
    expect(main?.text.includes(NOTICE)).toBe(false)
    expect(result.outputFiles.filter((file) => file.text.includes(NOTICE)).length).toBe(1)
  })

  test("a single-file app bundle can leave it out by name, and the page then says so", async () => {
    const out = join(work, "app-single")
    await build({
      stdin: {
        contents: `export { createRuntime } from ${JSON.stringify(join(dist, "index.js"))}`,
        resolveDir: work,
      },
      bundle: true,
      outfile: join(out, "app.js"),
      format: "esm",
      platform: "browser",
      external: [`./${ADMIN_CLIENT_ENTRY}.js`],
      logLevel: "silent",
    })
    const code = readFileSync(join(out, "app.js"), "utf8")
    expect(code.includes(NOTICE)).toBe(false)
    const { createRuntime } = (await import(join(out, "app.js"))) as {
      createRuntime: () => { fetch(request: Request): Promise<Response> }
    }
    const runtime = createRuntime()
    expect((await runtime.fetch(new Request("http://x/__admin/health"))).status).toBe(200)
    const page = await runtime.fetch(new Request("http://x/__admin/ui"))
    expect(page.status).toBe(503)
    expect(await page.text()).toContain("admin-ui.js")
  })
})

test("bundleServiceJs rejects a static import of the admin client", async () => {
  const pkg = fixture(
    "leaky",
    `${SERVICE}export { adminClientSource } from ${JSON.stringify(ADMIN_CLIENT_MODULE)}\n`,
  )
  await expect(
    bundleServiceJs({
      absWorkingDir: pkg,
      entryPoints: { index: "src/index.js" },
      outdir: "dist",
      platform: "neutral",
    }),
  ).rejects.toThrow(/imported statically/)
})
