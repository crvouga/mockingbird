import { mkdir, rm } from "node:fs/promises"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const outdir = resolve(root, "preview-dist")
await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })
const result = await Bun.build({
  entrypoints: [resolve(root, "src/preview.ts")],
  outdir,
  target: "browser",
  splitting: true,
  minify: true,
  naming: { entry: "[name].[ext]", chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
})
if (!result.success) throw new AggregateError(result.logs, "Preview build failed")
await Bun.write(
  resolve(outdir, "index.html"),
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lab system preview · Mockingbird</title>
<style>html,body,#system{height:100%;margin:0}body{font-family:system-ui}</style>
</head><body><main id="system" aria-label="Lab system preview"></main><script type="module" src="./preview.js"></script></body></html>`,
)
console.log(`Static system preview: ${outdir}`)
