import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { Glob } from "bun"

// The test task depends on the build, so the prerendered pages are on disk.
const client = join(import.meta.dir, "../dist/client")

const pages = [...new Glob("**/*.html").scanSync(client)].map((file) => {
  const html = readFileSync(join(client, file), "utf8")
  const path = `/${relative(".", file).split(sep).join("/")}`
    .replace(/(^|\/)index\.html$/, "")
    .replace(/\.html$/, "")
  return {
    path: path || "/",
    title: /<title>([^<]*)<\/title>/.exec(html)?.[1],
    description: /<meta name="description" content="([^"]*)"/.exec(html)?.[1],
    canonical: /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1],
    ogUrl: /<meta property="og:url" content="([^"]+)"/.exec(html)?.[1],
    noindex: /<meta name="robots" content="noindex"/.test(html),
  }
})

test("the build prerendered the site", () => {
  expect(pages.length).toBeGreaterThan(50)
})

test("a page served at two addresses names one of them canonical", () => {
  const byContent = new Map<string, typeof pages>()
  for (const page of pages.filter((p) => !p.noindex)) {
    const key = `${page.title}\n${page.description}`
    byContent.set(key, [...(byContent.get(key) ?? []), page])
  }
  const split = [...byContent.values()]
    .filter((same) => new Set(same.map((p) => p.canonical)).size > 1)
    .map((same) => same.map((p) => `${p.path} -> ${p.canonical}`))
  expect(split).toEqual([])
})

test("/docs/why defers to /why, the page the header and footer link", () => {
  const docsWhy = pages.find((p) => p.path === "/docs/why")
  expect(docsWhy?.canonical).toBe("https://mockingbird.chrisvouga.dev/why")
  expect(docsWhy?.ogUrl).toBe("https://mockingbird.chrisvouga.dev/why")
})
