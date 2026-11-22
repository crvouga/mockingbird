import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildPreview, stampPreviewVersion } from "./src/build.js"

const root = mkdtempSync(join(tmpdir(), "mockingbird-preview-build-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

writeFileSync(
  join(root, "app.ts"),
  `export const start = async (host: HTMLElement) => {
  const { label } = await import("./lazy.ts")
  host.textContent = label + " " + __FIXTURE__
  return () => { host.textContent = "" }
}
`,
)
writeFileSync(join(root, "lazy.ts"), `export const label = "fixture app"\n`)

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8")

describe("buildPreview", () => {
  test("builds a hashed app, the boot loader, index.html, build.json and a development version.json", async () => {
    const outdir = join(root, "out")
    // A stale file from an earlier build is removed.
    await buildPreview({
      entry: join(root, "app.ts"),
      outdir,
      esbuild: { define: { __FIXTURE__: '"x"' } },
    })
    writeFileSync(join(outdir, "stale.txt"), "old")
    const { entry } = await buildPreview({
      entry: join(root, "app.ts"),
      outdir,
      title: "Lab <preview>",
      hostId: "system",
      // Extra esbuild options reach the app build (here a define the app needs to compile).
      esbuild: { define: { __FIXTURE__: '"defined"' }, entryNames: "ignored-[name]" },
    })
    const files = readdirSync(outdir)
    expect(entry).toMatch(/^\.\/app-[A-Z0-9]+\.js$/)
    expect(files).toContain(entry.slice(2))
    expect(files).not.toContain("stale.txt")
    expect(files.filter((f) => f.endsWith(".js")).length).toBeGreaterThanOrEqual(3) // app, lazy chunk, preview
    expect(files).toEqual(
      expect.arrayContaining(["preview.js", "index.html", "build.json", "version.json"]),
    )
    expect(read(outdir, entry.slice(2))).toContain("defined")
    expect(JSON.parse(read(outdir, "build.json"))).toEqual({ entry })
    const version = JSON.parse(read(outdir, "version.json"))
    expect(version.version).toBe("development")
    expect(version.entry).toBe(entry)
    expect(Number.isNaN(Date.parse(version.builtAt))).toBe(false)

    const html = read(outdir, "index.html")
    expect(html).toContain('<script type="module" src="/preview.js"></script>')
    expect(html).toContain('<main id="system"')
    expect(html).toContain("<title>Lab &lt;preview&gt;</title>")

    const boot = read(outdir, "preview.js")
    expect(boot).toContain("#system")
    expect(boot).toContain("version.json")
    expect(boot).not.toContain("import ") // self-contained
  })

  // #867: `./preview.js` resolved against a deep link (`/settings/profile` -> `/settings/preview.js`),
  // which the single-page-application fallback answers with index.html.
  test("index.html loads the boot loader from the deployment root, so deep links boot", async () => {
    const outdir = join(root, "deep")
    await buildPreview({
      entry: join(root, "app.ts"),
      outdir,
      esbuild: { define: { __FIXTURE__: '"x"' } },
    })
    const src = /<script type="module" src="([^"]+)"><\/script>/.exec(read(outdir, "index.html"))?.[1]
    expect(src).toBe("/preview.js")
    for (const page of ["https://x.test/", "https://x.test/settings/profile", "https://x.test/a/b/c?d=1#e"])
      expect(new URL(src ?? "", page).href).toBe("https://x.test/preview.js")
    // The loader resolves version.json and the entry against its own URL (the deployment root),
    // never against the page's address.
    expect(read(outdir, "preview.js")).toContain("import.meta.url")
  })

  test("a sub-path deployment sets base", async () => {
    const outdir = join(root, "sub")
    await buildPreview({
      entry: join(root, "app.ts"),
      outdir,
      base: "/apps/lab/",
      esbuild: { define: { __FIXTURE__: '"x"' } },
    })
    expect(read(outdir, "index.html")).toContain(
      '<script type="module" src="/apps/lab/preview.js"></script>',
    )
    for (const base of ["apps/", "/apps", "/a b/", '/"x"/'])
      await expect(
        buildPreview({ entry: join(root, "app.ts"), outdir: join(root, "bad-base"), base }),
      ).rejects.toThrow("Invalid base")
  })

  test("rejects an unsafe host id", async () => {
    await expect(
      buildPreview({
        entry: join(root, "app.ts"),
        outdir: join(root, "bad"),
        hostId: 'x"><script',
      }),
    ).rejects.toThrow("Invalid hostId")
  })
})

describe("stampPreviewVersion", () => {
  test("writes the version, builtAt, the built entry and the PR", async () => {
    const outdir = join(root, "stamp")
    rmSync(outdir, { recursive: true, force: true })
    mkdirSync(outdir)
    writeFileSync(join(outdir, "build.json"), JSON.stringify({ entry: "./app-XYZ.js" }))
    await stampPreviewVersion({
      outdir,
      version: "f".repeat(40),
      builtAt: "2026-11-20T00:00:00.000Z",
      pr: { number: 9, url: "https://github.com/o/r/pull/9" },
    })
    expect(JSON.parse(read(outdir, "version.json"))).toEqual({
      version: "f".repeat(40),
      builtAt: "2026-11-20T00:00:00.000Z",
      entry: "./app-XYZ.js",
      pr: { number: 9, url: "https://github.com/o/r/pull/9" },
    })
    await stampPreviewVersion({ outdir, version: "abc" })
    const plain = JSON.parse(read(outdir, "version.json"))
    expect(plain.pr).toBeUndefined()
    expect(plain.entry).toBe("./app-XYZ.js")
  })

  test("fails without build.json", async () => {
    await expect(
      stampPreviewVersion({ outdir: join(root, "missing"), version: "abc" }),
    ).rejects.toThrow()
  })
})
