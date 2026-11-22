import { resolve } from "node:path"
import { browserRuntimeBuildOptions } from "@crvouga/mockingbird-adapter-browser/build"

const root = resolve(import.meta.dir, "..")

/**
 * What the lab's preview is built from, for the deployed build (`build-preview.ts`) and the dev
 * server (`dev-preview.ts`) alike: the app (`src/app.ts`, built with the browser runtime so Node
 * and Bun APIs work in the tab) behind the package's boot loader.
 */
export const previewOptions = {
  entry: resolve(root, "src/app.ts"),
  title: "Lab system preview · Mockingbird",
  hostId: "system",
  esbuild: { ...browserRuntimeBuildOptions(), absWorkingDir: root },
}
export const previewOutdir = resolve(root, "preview-dist")
