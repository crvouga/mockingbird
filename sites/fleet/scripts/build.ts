/**
 * Bundle the server (one lazy chunk per emulator) and the dashboard into `dist/`. The dashboard is
 * three files: `index.html`, `app.js` (React, HeroUI and the screens) and `app.css`, Mockingbird's
 * precompiled stylesheet (`@crvouga/mockingbird-ui/styles.css`).
 */
import { readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { MARK_FAVICON } from "@crvouga/mockingbird-ui/document"

const root = join(import.meta.dir, "..")
const dist = join(root, "dist")
await rm(dist, { recursive: true, force: true })

const server = await Bun.build({
  entrypoints: [join(root, "src/main.ts")],
  outdir: dist,
  target: "bun",
  splitting: true,
  // Whitespace only: names stay readable in production stack traces.
  minify: { whitespace: true, syntax: true, identifiers: false },
})
const ui = await Bun.build({
  entrypoints: [join(root, "src/ui/app.ts")],
  outdir: join(dist, "public"),
  target: "browser",
  minify: true,
  // React and HeroUI pick their production build from NODE_ENV.
  define: { "process.env.NODE_ENV": '"production"' },
})
for (const result of [server, ui])
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
// The bird favicon is a data: URL, so the page still asks the server for nothing but its files.
const html = await readFile(join(root, "src/ui/index.html"), "utf8")
await writeFile(
  join(dist, "public/index.html"),
  html.replace("</title>", `</title>\n    <link rel="icon" href="${MARK_FAVICON}" />`),
)
// Plus the one rule React Aria would otherwise inject as a <style> element (see index.html).
const styles = await readFile(Bun.resolveSync("@crvouga/mockingbird-ui/styles.css", root), "utf8")
await writeFile(
  join(dist, "public/app.css"),
  `${styles}\n@layer{[data-react-aria-pressable]{touch-action:pan-x pan-y pinch-zoom}}\n`,
)
console.log(`built ${server.outputs.length} server files, ${ui.outputs.length} dashboard files`)
