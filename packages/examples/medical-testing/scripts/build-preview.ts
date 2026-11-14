import { mkdir, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { browserRuntimeBuildOptions } from "@crvouga/mockingbird-adapter-browser/build"
import { build } from "esbuild"

const root = resolve(import.meta.dir, "..")
const outdir = resolve(root, "preview-dist")
await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })
await build({
  ...browserRuntimeBuildOptions(),
  bundle: true,
  format: "esm",
  entryPoints: [resolve(root, "src/preview.ts")],
  outdir,
  target: "es2022",
  splitting: true,
  minify: true,
  entryNames: "[name]",
  chunkNames: "[name]-[hash]",
  assetNames: "[name]-[hash]",
})
await Bun.write(
  resolve(outdir, "index.html"),
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lab system preview · Mockingbird</title>
<style>html,body,#system{height:100%;margin:0}body{font-family:system-ui}</style>
</head><body><main id="system" aria-label="Lab system preview"></main><script type="module" src="./preview.js"></script></body></html>`,
)
console.log(`Static system preview: ${outdir}`)
