import { mkdir, rm } from "node:fs/promises"
import { basename, resolve } from "node:path"
import { browserRuntimeBuildOptions } from "@crvouga/mockingbird-adapter-browser/build"
import { build } from "esbuild"

const root = resolve(import.meta.dir, "..")
const outdir = resolve(root, "preview-dist")
await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })

// The app: one hashed entry per version, so a new deploy's entry never collides with the one an
// open tab is running, and the boot loader can import it into the same page.
const app = await build({
  ...browserRuntimeBuildOptions(),
  bundle: true,
  format: "esm",
  entryPoints: { app: resolve(root, "src/app.ts") },
  outdir,
  target: "es2022",
  splitting: true,
  minify: true,
  metafile: true,
  entryNames: "[name]-[hash]",
  chunkNames: "[name]-[hash]",
  assetNames: "[name]-[hash]",
})
const entry = Object.entries(app.metafile.outputs).find(([, output]) =>
  output.entryPoint?.endsWith("src/app.ts"),
)?.[0]
if (!entry) throw new Error("The app build produced no entry")

// The boot loader: a stable name, loaded by index.html, never swapped.
await build({
  bundle: true,
  format: "esm",
  entryPoints: { preview: resolve(root, "src/preview.ts") },
  outdir,
  target: "es2022",
  minify: true,
  entryNames: "[name]",
})

const manifest = { entry: `./${basename(entry)}` }
await Bun.write(resolve(outdir, "build.json"), `${JSON.stringify(manifest)}\n`)
// Deploys overwrite this with the commit they ship (scripts/stamp-version.ts).
await Bun.write(
  resolve(outdir, "version.json"),
  `${JSON.stringify({ version: "development", builtAt: new Date().toISOString(), ...manifest })}\n`,
)
await Bun.write(
  resolve(outdir, "index.html"),
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lab system preview · Mockingbird</title>
<style>html,body,#system{height:100%;margin:0}body{font-family:system-ui}</style>
</head><body><main id="system" aria-label="Lab system preview"></main><script type="module" src="./preview.js"></script></body></html>`,
)
console.log(`Static system preview: ${outdir} (app entry ${manifest.entry})`)
