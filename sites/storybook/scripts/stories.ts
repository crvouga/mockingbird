/**
 * Drives a built Storybook in headless Chromium: serves `storybook-static`, opens each story's
 * iframe and waits for Storybook to report it rendered (after its `play` function) or failed.
 * Shared by `verify.ts` (every story must draw cleanly) and `screenshots.ts`.
 */
import { existsSync } from "node:fs"
import { join, normalize } from "node:path"
import { type Browser, type BrowserContextOptions, chromium, type Page } from "@playwright/test"

export const ROOT = join(import.meta.dir, "..")
export const STATIC = join(ROOT, "storybook-static")

export type Entry = {
  id: string
  title: string
  name: string
  type: string
  importPath: string
  tags?: string[]
}

/** The built docs site, whose pages the "Docs site" stories frame. */
export const DOCS = join(ROOT, "../docs/dist/client")
export const hasDocs = () => existsSync(join(DOCS, "index.html"))

async function file(dir: string, path: string): Promise<Response | undefined> {
  for (const candidate of [path, join(path, "index.html"), `${path}.html`]) {
    const found = Bun.file(join(dir, candidate))
    if (!candidate.endsWith("/") && (await found.exists())) return new Response(found)
  }
  return undefined
}

/**
 * Serve the catalog as the docs site does: the built Storybook (with its composed refs) at
 * `/storybook/`, and the built docs site, when there is one, at `/`. `base` is the catalog's URL.
 */
export function serve(dir = STATIC) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = normalize(decodeURIComponent(new URL(request.url).pathname))
      if (path === "/storybook" || path.startsWith("/storybook/"))
        return (
          (await file(dir, path.slice("/storybook".length) || "/")) ??
          new Response("Not found", { status: 404 })
        )
      const page = hasDocs() ? await file(DOCS, path) : undefined
      if (page) return page
      const missing = Bun.file(join(DOCS, "404.html"))
      return new Response((await missing.exists()) ? missing : "Not found", {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    },
  })
  return Object.assign(server, { base: `http://127.0.0.1:${server.port}/storybook` })
}

export async function entries(base: string): Promise<Entry[]> {
  const index = (await (await fetch(`${base}/index.json`)).json()) as {
    entries: Record<string, Entry>
  }
  return Object.values(index.entries).filter((entry) => entry.type === "story")
}

/** Resolves once Storybook's preview channel says how the current story ended. */
const OUTCOME = `new Promise((resolve) => {
  const wait = () => {
    const channel = window.__STORYBOOK_ADDONS_CHANNEL__
    if (!channel) return setTimeout(wait, 20)
    channel.on("storyRendered", () => resolve({ ok: true }))
    for (const event of ["storyErrored", "storyThrewException", "playFunctionThrewException", "storyMissing"])
      channel.on(event, (error) => resolve({ ok: false, event, error: String(error?.message ?? error?.description ?? error?.title ?? event) }))
  }
  wait()
})`

export type Outcome = { id: string; ok: boolean; problems: string[] }

/** Open one story; resolves when it rendered (and played), with every error it logged. */
export async function render(
  page: Page,
  base: string,
  story: Pick<Entry, "id" | "tags">,
  timeout = 30_000,
): Promise<Outcome> {
  const { id } = story
  // A story tagged `expect-404` shows a page whose own status is 404, which Chromium logs.
  const expected = story.tags?.includes("expect-404") ? /status of 404/ : undefined
  const problems: string[] = []
  const onConsole = (message: { type(): string; text(): string }) => {
    if (message.type() === "error" && !expected?.test(message.text())) problems.push(message.text())
  }
  const onError = (error: Error) => problems.push(String(error))
  page.on("console", onConsole)
  page.on("pageerror", onError)
  try {
    await page.goto(`${base}/iframe.html?id=${id}&viewMode=story`)
    const outcome = (await Promise.race([
      page.evaluate(OUTCOME),
      new Promise((resolve) =>
        setTimeout(() => resolve({ ok: false, error: "timed out" }), timeout),
      ),
    ])) as { ok: boolean; error?: string }
    if (!outcome.ok) problems.unshift(outcome.error ?? "failed")
    // Let a frame that just navigated settle before anyone looks at it.
    await page.waitForLoadState("networkidle").catch(() => {})
    return { id, ok: outcome.ok && problems.length === 0, problems }
  } finally {
    page.off("console", onConsole)
    page.off("pageerror", onError)
  }
}

/** Run `job` over `items` on `concurrency` pages of one browser. */
export async function pool<T, R>(
  browser: Browser,
  items: T[],
  job: (page: Page, item: T) => Promise<R>,
  { concurrency = 4, context = {} as BrowserContextOptions } = {},
): Promise<R[]> {
  const results: R[] = []
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      // A fresh page per story, so nothing one story logs late is blamed on the next.
      const browserContext = await browser.newContext(context)
      while (next < items.length) {
        const index = next++
        const page = await browserContext.newPage()
        results[index] = await job(page, items[index] as T)
        await page.close()
      }
      await browserContext.close()
    }),
  )
  return results
}

/** Headless Chromium, downloaded first when this machine has none (as on a fresh CI runner). */
export async function launch(): Promise<Browser> {
  if (!existsSync(chromium.executablePath())) {
    const install = Bun.spawnSync(
      ["bunx", "playwright", "install", ...(process.env.CI ? ["--with-deps"] : []), "chromium"],
      { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] },
    )
    if (install.exitCode !== 0) throw new Error("could not install Chromium for Playwright")
  }
  return chromium.launch()
}
