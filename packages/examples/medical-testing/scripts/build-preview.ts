import { resolve } from "node:path"
import { browserRuntimeBuildOptions } from "@crvouga/mockingbird-adapter-browser/build"
import { buildPreview } from "@crvouga/mockingbird-preview/build"

/**
 * The lab's static PR preview: the app (`src/app.ts`, built with the browser runtime so Node and
 * Bun APIs work in the tab) behind the package's boot loader, which keeps it live and updates it
 * in place. Deploys stamp `version.json` (`mockingbird-preview stamp`).
 */
const root = resolve(import.meta.dir, "..")
const { entry } = await buildPreview({
  entry: resolve(root, "src/app.ts"),
  outdir: resolve(root, "preview-dist"),
  title: "Lab system preview · Mockingbird",
  hostId: "system",
  esbuild: browserRuntimeBuildOptions(),
})
console.log(`Static system preview: ${resolve(root, "preview-dist")} (app entry ${entry})`)
