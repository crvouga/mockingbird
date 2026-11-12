/**
 * Photograph the catalog, for a PR or a design review:
 *
 *   bun run screenshots                                   # build, then every story at laptop width
 *   bun run screenshots --no-build --only emulators-stripe --phone --video
 *
 * `--only <prefix>` limits it to stories whose id starts with the prefix; `--phone` adds a 390px
 * capture of each; `--video` records each story that has a `play` function (typing, submitting)
 * as WebM. Output lands in `.tmp/screenshots` with `manifest.json`. Exits 1 when a story fails.
 */
import { mkdir, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { entries, launch, ROOT, render, serve } from "./stories.js"

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const only = flag("--only") ? args[args.indexOf("--only") + 1] : undefined
const out = join(ROOT, ".tmp/screenshots")

if (!flag("--no-build")) {
  const build = Bun.spawnSync(["bun", "run", "storybook:build"], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
  })
  if (build.exitCode !== 0) process.exit(build.exitCode ?? 1)
}

const server = serve()
const base = server.base
const stories = (await entries(base)).filter((entry) => !only || entry.id.startsWith(only))
await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

type Capture = {
  id: string
  title: string
  name: string
  file: string
  kind: "laptop" | "phone" | "video"
}
const manifest: Capture[] = []
const failures: string[] = []
const browser = await launch()

const VIEWPORTS = {
  laptop: { width: 1280, height: 800 },
  phone: { width: 390, height: 844 },
} as const

for (const story of stories) {
  for (const kind of flag("--phone") ? (["laptop", "phone"] as const) : (["laptop"] as const)) {
    const context = await browser.newContext({ viewport: VIEWPORTS[kind], deviceScaleFactor: 2 })
    const page = await context.newPage()
    const outcome = await render(page, base, story)
    if (!outcome.ok) failures.push(`${story.id}: ${outcome.problems.join("; ")}`)
    const file = `${story.id}${kind === "phone" ? "--phone" : ""}.png`
    await page.screenshot({ path: join(out, file), fullPage: true })
    manifest.push({ id: story.id, title: story.title, name: story.name, file, kind })
    await context.close()
  }
}

if (flag("--video")) {
  // Stories whose source has a `play`: record them acting, at the pace the play types.
  const sources = new Map<string, string>()
  for (const story of stories) {
    const path = join(ROOT, story.importPath)
    sources.set(path, sources.get(path) ?? (await Bun.file(path).text()))
  }
  const playing = stories.filter((story) => {
    const source = sources.get(join(ROOT, story.importPath)) ?? ""
    const name =
      story.id.split("--")[1]?.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase()) ?? ""
    const exported = new RegExp(
      `export const ${name.charAt(0).toUpperCase()}${name.slice(1)}\\b[\\s\\S]*?(?=\\nexport const|$)`,
      "i",
    )
    return /\bplay\b/.test(source.match(exported)?.[0] ?? "")
  })
  for (const story of playing) {
    const context = await browser.newContext({
      viewport: VIEWPORTS.laptop,
      recordVideo: { dir: join(out, "raw"), size: VIEWPORTS.laptop },
    })
    const page = await context.newPage()
    await render(page, base, story)
    await page.waitForTimeout(800)
    const video = page.video()
    await context.close()
    const file = `${story.id}.webm`
    if (video) await rename(await video.path(), join(out, file))
    manifest.push({ id: story.id, title: story.title, name: story.name, file, kind: "video" })
  }
  await rm(join(out, "raw"), { recursive: true, force: true })
}

await browser.close()
server.stop()
await Bun.write(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
for (const failure of failures) console.error(`✗ ${failure}`)
console.log(`${manifest.length} captures in ${out}`)
process.exit(failures.length ? 1 : 0)
