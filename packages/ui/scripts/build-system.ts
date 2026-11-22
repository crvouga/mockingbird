/**
 * Bundle the System harness's React view (src/system-view.tsx) into dist/system-view.js, over the
 * module tsc emitted: React, react-dom, HeroUI and the shared components inlined as one minified
 * ES module, so `@crvouga/mockingbird-ui/system` keeps working in an app that installs neither
 * React nor HeroUI (they stay optional peers). `mountSystemHarness` imports it lazily, so nothing
 * of it loads until a harness mounts. The stylesheet stays an import of the sibling
 * dist/styles.js, so it ships once. Run after build-css.ts and tsc (`bun run build`).
 */
import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { collectNotices, noticeComment } from "./notices.ts"

const root = join(import.meta.dir, "..")
const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/system-view.tsx"],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  minify: true,
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"', process: "undefined" },
  write: false,
  metafile: true,
  logLevel: "warning",
  plugins: [
    {
      name: "sibling-stylesheet",
      setup(builder) {
        // src/ imports ../dist/styles.js; from dist/ that is ./styles.js.
        builder.onResolve({ filter: /\/styles\.js$/ }, () => ({
          path: "./styles.js",
          external: true,
        }))
      },
    },
  ],
})
const output = result.outputFiles?.[0]
if (!output || !result.metafile) throw new Error("src/system-view.tsx: esbuild produced no output")
const notices = await collectNotices(
  Object.keys(result.metafile.inputs).map((input) => resolve(root, input)),
)
const text = `${noticeComment("Bundled third-party notices", notices)}${output.text}`
await writeFile(join(root, "dist/system-view.js"), text)
console.log(`ui: bundled system-view.js (${Math.round(text.length / 1024)} KiB)`)
