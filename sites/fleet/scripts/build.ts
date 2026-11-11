/** Bundle the server (one lazy chunk per emulator) and the dashboard into `dist/`. */
import { cp, rm } from "node:fs/promises"
import { join } from "node:path"

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
})
for (const result of [server, ui])
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
await cp(join(root, "src/ui/index.html"), join(dist, "public/index.html"))
await cp(join(root, "src/ui/app.css"), join(dist, "public/app.css"))
console.log(`built ${server.outputs.length} server files, ${ui.outputs.length} dashboard files`)
