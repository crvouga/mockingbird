/**
 * Compile src/stylesheet.css (Tailwind CSS v4 + HeroUI v3 + the Mockingbird theme, scanning
 * every Mockingbird surface for the utilities it uses) into:
 *
 *   dist/styles.css   `@crvouga/mockingbird-ui/styles.css`, for bundlers and <link>
 *   dist/styles.js    `MOCKINGBIRD_CSS` from `@crvouga/mockingbird-ui/styles`, for inlining
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { join } from "node:path"
import { $ } from "bun"
import { collectNotices, noticeComment } from "./notices.ts"

const root = join(import.meta.dir, "..")
const dist = join(root, "dist")
await mkdir(dist, { recursive: true })
const out = join(dist, "styles.css")
await $`${join(root, "node_modules/.bin/tailwindcss")} --input ${join(root, "src/stylesheet.css")} --output ${out} --minify`
  .cwd(root)
  .quiet()
const css = await readFile(out, "utf8")
// The CSS compiled in comes from these packages (tw-animate-css through @heroui/styles).
const require = createRequire(join(root, "package.json"))
const heroui = require.resolve("@heroui/styles/package.json")
const sources = [
  require.resolve("tailwindcss/package.json"),
  heroui,
  createRequire(heroui).resolve("tw-animate-css/package.json"),
]
const stylesheet =
  noticeComment("Bundled third-party notices", await collectNotices(sources)) +
  css.replace(/^\/\*![\s\S]*?\*\/\n?/, "")
await writeFile(out, stylesheet)
await writeFile(
  join(dist, "styles.js"),
  `/** Compiled by scripts/build-css.ts from src/stylesheet.css. */\nexport const MOCKINGBIRD_CSS = ${JSON.stringify(stylesheet)}\n`,
)
await writeFile(join(dist, "styles.d.ts"), "export declare const MOCKINGBIRD_CSS: string\n")
console.log(`ui: compiled styles.css (${Math.round(stylesheet.length / 1024)} KiB)`)
