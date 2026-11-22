import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { build } from "esbuild"

const root = join(import.meta.dir, "..")
const result = await build({
  entryPoints: [join(root, "src/browser-global.ts")],
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  globalName: "MockingbirdDaily",
  target: "es2022",
  minify: true,
})
const source = `export const dailyBrowserScript = ${JSON.stringify(result.outputFiles[0]?.text)}\n`
const target = join(root, "src/generated/browser-script.ts")
if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf8")) !== source)
    throw new Error("Daily browser script is stale; run bun scripts/generate-browser.ts")
} else await writeFile(target, source)
