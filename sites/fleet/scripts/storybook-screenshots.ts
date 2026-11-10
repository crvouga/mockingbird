/**
 * Photograph every story:
 *   bun run storybook:screenshots            # build Storybook, then capture
 *   bun run storybook:screenshots --no-build # capture the existing storybook-static
 *
 * Each story is captured at desktop width in light mode; the first story of each screen is also
 * captured at phone width and in dark mode. Images and `manifest.json` (one entry per capture)
 * land in `.tmp/screenshots`. Exits 1 when a story fails to draw or logs an error.
 */
import { mkdir, rm } from "node:fs/promises"
import { join, normalize } from "node:path"
import { type Browser, chromium } from "@playwright/test"

const root = join(import.meta.dir, "..")
const site = join(root, "storybook-static")
const out = join(root, ".tmp/screenshots")

const VARIANTS = {
  desktop: { viewport: { width: 1280, height: 800 }, colorScheme: "light" },
  mobile: { viewport: { width: 390, height: 844 }, colorScheme: "light" },
  dark: { viewport: { width: 1280, height: 800 }, colorScheme: "dark" },
} as const
type Variant = keyof typeof VARIANTS
type Capture = { id: string; title: string; name: string; variant: Variant; file: string }

if (!process.argv.includes("--no-build")) {
  const build = Bun.spawnSync(["bun", "run", "storybook:build"], {
    cwd: root,
    stdio: ["ignore", "inherit", "inherit"],
  })
  if (build.exitCode !== 0) process.exit(build.exitCode ?? 1)
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const path = normalize(decodeURIComponent(new URL(request.url).pathname))
    const file = Bun.file(join(site, path.endsWith("/") ? `${path}index.html` : path))
    return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 })
  },
})

const index = (await Bun.file(join(site, "index.json")).json()) as {
  entries: Record<string, { id: string; title: string; name: string; type: string }>
}
const stories = Object.values(index.entries).filter((entry) => entry.type === "story")
const primary = new Set([
  ...new Map([...stories].reverse().map((story) => [story.title, story.id])).values(),
])
const jobs: Omit<Capture, "file">[] = stories.flatMap(({ id, title, name }) =>
  (primary.has(id) ? (["desktop", "mobile", "dark"] as const) : (["desktop"] as const)).map(
    (variant) => ({ id, title, name, variant }),
  ),
)

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

const problems: string[] = []
const captures: Capture[] = []

async function capture(browser: Browser, job: Omit<Capture, "file">) {
  const context = await browser.newContext({
    ...VARIANTS[job.variant],
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
  })
  const page = await context.newPage()
  const label = `${job.id} (${job.variant})`
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`${label}: console error: ${message.text()}`)
  })
  page.on("pageerror", (error) => problems.push(`${label}: uncaught ${error.message}`))
  const file = job.variant === "desktop" ? `${job.id}.png` : `${job.id}--${job.variant}.png`
  try {
    await page.goto(`${server.url}iframe.html?id=${job.id}&viewMode=story`, { timeout: 60_000 })
    await page.locator("#storybook-root > .story > #app > *").first().waitFor({ timeout: 60_000 })
    await page.evaluate(() => document.fonts.ready)
    const size = await page.locator("#storybook-root").boundingBox()
    if (!size || size.height < 20) problems.push(`${label}: drew nothing`)
    await page.screenshot({ path: join(out, file), fullPage: true })
    captures.push({ ...job, file })
  } catch (error) {
    problems.push(`${label}: ${(error as Error).message.split("\n")[0]}`)
  } finally {
    await context.close()
  }
}

const browser = await chromium.launch()
try {
  const queue = [...jobs]
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) await capture(browser, job)
    }),
  )
} finally {
  await browser.close()
  await server.stop(true)
}

const order = new Map(jobs.map((job, position) => [`${job.id} ${job.variant}`, position]))
const position = (entry: Capture) => order.get(`${entry.id} ${entry.variant}`) ?? 0
captures.sort((left, right) => position(left) - position(right))
await Bun.write(join(out, "manifest.json"), `${JSON.stringify(captures, null, 2)}\n`)

console.log(`${captures.length} screenshots of ${stories.length} stories in ${out}`)
if (problems.length > 0) {
  console.error(`${problems.length} problems:\n${problems.map((line) => `  ${line}`).join("\n")}`)
  process.exit(1)
}
