/**
 * Services share one published runtime instead of each inlining a 1.5 MB copy of it and of the
 * admin page's client (#699, #766). Builds two fixture services the way bundle-service.ts does,
 * against the built `@crvouga/mockingbird-runtime`, and checks what lands in their `dist`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ADMIN_CLIENT_ENTRY, bundleServiceJs } from "./bundle-service-js.ts"
import {
  RUNTIME_DIR,
  RUNTIME_PACKAGE,
  runtimeSpecifier,
  runtimeSubpaths,
  sharedRuntimeLeaks,
  sharedRuntimePlugin,
} from "./bundle-service-runtime.ts"

const ADMIN_STRING = "ADMIN_BROWSER_BUNDLE"
/** What one service's own code and glue may weigh once the runtime is shared. */
const FIXTURE_BUDGET_BYTES = 8 * 1024

describe("the runtime package", () => {
  test("helper imports map to its subpaths; everything else is left alone", () => {
    const subpaths = runtimeSubpaths()
    expect(runtimeSpecifier("@crvouga/mockingbird-core", subpaths)).toBe(`${RUNTIME_PACKAGE}/core`)
    expect(runtimeSpecifier("@crvouga/mockingbird-service/admin", subpaths)).toBe(
      `${RUNTIME_PACKAGE}/service/admin`,
    )
    expect(runtimeSpecifier("@crvouga/mockingbird-service-sqlite", subpaths)).toBeUndefined()
    expect(runtimeSpecifier("@crvouga/mockingbird-commands", subpaths)).toBeUndefined()
    expect(runtimeSpecifier("hono", subpaths)).toBeUndefined()
  })

  test("a metafile input from a helper the runtime ships is a leak", () => {
    const metafile = {
      inputs: {
        "src/index.js": { bytes: 1, imports: [] },
        "../../core/dist/index.js": { bytes: 1, imports: [] },
      },
      outputs: {},
    }
    expect(sharedRuntimeLeaks(metafile, join(RUNTIME_DIR, "..", "service", "sqs"))).toEqual([
      "@crvouga/mockingbird-core: ../../core/dist/index.js",
    ])
  })
})

const work = mkdtempSync(join(tmpdir(), "bundle-service-runtime-"))
afterAll(() => rmSync(work, { recursive: true, force: true }))
// Fixtures resolve the runtime the way an installed service does: from node_modules.
mkdirSync(join(work, "node_modules", "@crvouga"), { recursive: true })
symlinkSync(RUNTIME_DIR, join(work, "node_modules", "@crvouga", "mockingbird-runtime"), "dir")

const BRAND = {
  vendor: "Fixture",
  website: "https://fixture.test",
  docs: null,
  guide: "",
  logo: "",
}

const fixture = (name: string, version: string) => {
  const dir = join(work, name)
  mkdirSync(join(dir, "src"), { recursive: true })
  writeFileSync(
    join(dir, "src", "index.js"),
    `import { createRuntime as runtime, DroppedConnectionError } from "@crvouga/mockingbird-service"
import { requestBaseUrl } from "@crvouga/mockingbird-core"
export { DroppedConnectionError, requestBaseUrl }
export const createRuntime = () =>
  runtime({
    name: ${JSON.stringify(name)},
    create: () => ({ fetch: async () => new Response("ok"), reset: async () => {} }),
  })
`,
  )
  return {
    dir,
    dist: join(dir, "dist"),
    build: () =>
      bundleServiceJs({
        absWorkingDir: dir,
        entryPoints: { index: "src/index.js" },
        outdir: "dist",
        platform: "neutral",
        define: {
          __MOCKINGBIRD_PACKAGE_VERSION__: JSON.stringify(version),
          __MOCKINGBIRD_ADMIN_BRAND__: JSON.stringify({ ...BRAND, vendor: name }),
        },
        external: [RUNTIME_PACKAGE],
        plugins: [sharedRuntimePlugin()],
      }),
  }
}

type FixtureModule = {
  createRuntime: () => { fetch(request: Request): Promise<Response> }
  DroppedConnectionError: unknown
  requestBaseUrl: unknown
}

describe("a service built on the shared runtime", () => {
  const one = fixture("one", "1.2.3")
  const two = fixture("two", "4.5.6")
  let leaks: string[] = []
  beforeAll(async () => {
    leaks = sharedRuntimeLeaks(await one.build(), one.dir)
    await two.build()
  })
  const files = (dist: string) => readdirSync(dist).filter((file) => file.endsWith(".js"))

  test("inlines no runtime helper and no admin client", () => {
    expect(leaks).toEqual([])
    expect(files(one.dist)).not.toContain(`${ADMIN_CLIENT_ENTRY}.js`)
    for (const file of files(one.dist))
      expect(readFileSync(join(one.dist, file), "utf8").includes(ADMIN_STRING)).toBe(false)
    const code = files(one.dist)
      .map((file) => readFileSync(join(one.dist, file), "utf8"))
      .join("\n")
    expect(code).toContain(`"${RUNTIME_PACKAGE}/service"`)
    expect(code).toContain(`"${RUNTIME_PACKAGE}/core"`)
  })

  test("stays within its size budget", () => {
    const bytes = files(one.dist).reduce(
      (sum, file) => sum + statSync(join(one.dist, file)).size,
      0,
    )
    expect(bytes).toBeLessThan(FIXTURE_BUDGET_BYTES)
  })

  test("two services load the same runtime module, each reporting its own version and brand", async () => {
    const a = (await import(join(one.dist, "index.js"))) as FixtureModule
    const b = (await import(join(two.dist, "index.js"))) as FixtureModule
    expect(a.DroppedConnectionError).toBe(b.DroppedConnectionError)
    expect(a.requestBaseUrl).toBe(b.requestBaseUrl)
    for (const [mod, name, version] of [
      [a, "one", "1.2.3"],
      [b, "two", "4.5.6"],
    ] as const) {
      const runtime = mod.createRuntime()
      const health = await runtime.fetch(new Request("http://x/__admin/health"))
      expect(health.status).toBe(200)
      expect(health.headers.get("x-mockingbird")).toContain(`${name}@${version}`)
      const brands = await runtime.fetch(new Request("http://x/__admin/ui/brands.json"))
      expect(await brands.json()).toEqual({ [name]: { ...BRAND, vendor: name } })
    }
  })

  test("the admin page is served from the runtime's own client file", async () => {
    const { createRuntime } = (await import(join(one.dist, "index.js"))) as FixtureModule
    const page = await createRuntime().fetch(new Request("http://x/__admin/ui"))
    expect(page.status).toBe(200)
    expect(await page.text()).toContain("MockingbirdAdmin.mount(")
  })
})
