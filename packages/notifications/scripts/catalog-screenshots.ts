/**
 * Photograph every Storybook story: builds the static Storybook (unless --no-build), serves it,
 * and writes one PNG per story plus `catalog/manifest.json` (title, name, file) for review.
 *
 *   bun run catalog:screenshots              # → catalog/*.png
 *   bun run catalog:screenshots -- --no-build
 *
 * Each story picks its viewport with a `vp-*` tag; the clock and time zone are fixed, so the
 * pictures only change when the UI does.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { extname, join } from "node:path"
import { chromium } from "@playwright/test"

const root = join(import.meta.dir, "..")
const staticDir = join(root, "storybook-static")
const outDir = join(root, "catalog")

if (!process.argv.includes("--no-build")) {
  const build = Bun.spawnSync(["bun", "run", "storybook:build"], {
    cwd: root,
    stdio: ["ignore", "inherit", "inherit"],
  })
  if (build.exitCode !== 0) process.exit(build.exitCode ?? 1)
}

const VIEWPORTS: Record<string, { width: number; height: number }> = {
  "vp-phone": { width: 520, height: 1000 },
  "vp-mail": { width: 1300, height: 1000 },
  "vp-desktop": { width: 1720, height: 1040 },
  "vp-laptop": { width: 1280, height: 900 },
  "vp-laptop-narrow": { width: 900, height: 900 },
  "vp-mobile": { width: 390, height: 844 },
}

type Entry = { id: string; title: string; name: string; type: string; tags?: string[] }
const index = JSON.parse(readFileSync(join(staticDir, "index.json"), "utf8")) as {
  entries: Record<string, Entry>
}
const stories = Object.values(index.entries).filter((e) => e.type === "story")

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
}
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname)
    const file = Bun.file(join(staticDir, path === "/" ? "index.html" : path))
    return new Response(file, {
      headers: { "content-type": TYPES[extname(path)] ?? "application/octet-stream" },
    })
  },
})

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const browser = await chromium.launch()
const manifest: { id: string; title: string; name: string; file: string; viewport: string }[] = []
const failures: string[] = []
try {
  for (const [i, story] of stories.entries()) {
    const viewport = [...(story.tags ?? [])].reverse().find((t) => t in VIEWPORTS) ?? "vp-desktop"
    const context = await browser.newContext({
      viewport: VIEWPORTS[viewport] ?? null,
      locale: "en-US",
      timezoneId: "America/Los_Angeles",
      reducedMotion: "reduce",
    })
    const page = await context.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    // A cold first load can miss Storybook's render; one reload settles it.
    for (let attempt = 1; ; attempt++) {
      await page.goto(`${server.url}iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`)
      try {
        await page.waitForSelector("#storybook-root .devices, #storybook-root .timeline", {
          state: "attached",
          timeout: 15_000,
        })
        break
      } catch (error) {
        if (attempt >= 2) throw error
      }
    }
    await page.waitForLoadState("networkidle")
    await page.waitForTimeout(250)
    const file = `${String(i + 1).padStart(3, "0")}-${story.id.replace(/[^a-z0-9-]+/gi, "-")}.png`
    await page.screenshot({ path: join(outDir, file), fullPage: true, animations: "disabled" })
    if (errors.length) failures.push(`${story.id}: ${errors.join("; ")}`)
    manifest.push({ id: story.id, title: story.title, name: story.name, file, viewport })
    await context.close()
    console.log(`catalog: ${file}`)
  }
} finally {
  await browser.close()
  server.stop(true)
}
writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
if (failures.length) {
  console.error(`catalog: page errors\n${failures.join("\n")}`)
  process.exit(1)
}
console.log(`catalog: ${manifest.length} screenshots → ${outDir}`)
