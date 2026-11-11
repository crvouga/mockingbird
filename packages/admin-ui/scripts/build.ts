import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { type BuildOptions, build } from "esbuild"

const options: BuildOptions = {
  entryPoints: ["src/browser.tsx"],
  bundle: true,
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  minify: true,
  legalComments: "inline",
  // This bundle only executes in browsers, including embedded service documents.
  // Remove library fallbacks for Node's process instead of shipping runtime shims.
  define: { "process.env.NODE_ENV": '"production"', process: "undefined" },
  write: false,
}
const result = await build({
  ...options,
  format: "iife",
  globalName: "MockingbirdAdmin",
  metafile: true,
})
const output = result.outputFiles?.[0]
if (!output || !result.metafile) throw new Error("Admin UI build produced no bundle")
// Published services inline this bundle, so carry the bundled packages' licenses
// inside it rather than depending on node_modules or a separate hosted asset.
const notices = new Map<string, string>()
for (const input of Object.keys(result.metafile.inputs).sort()) {
  if (!input.includes("node_modules/")) continue
  let directory = dirname(resolve(input))
  while (directory !== dirname(directory)) {
    const manifest = resolve(directory, "package.json")
    if (existsSync(manifest)) {
      const pkg = JSON.parse(await readFile(manifest, "utf8")) as {
        name?: string
        version?: string
      }
      if (!pkg.name) {
        directory = dirname(directory)
        continue
      }
      const key = `${pkg.name}@${pkg.version}`
      if (!notices.has(key)) {
        const licenses = (await readdir(directory))
          .filter((file) => /^licen[sc]e(?:$|[.-])/i.test(file))
          .sort()
        const content = await Promise.all(
          licenses.map((file) => readFile(resolve(directory, file), "utf8")),
        )
        if (content.length) notices.set(key, content.join("\n\n"))
      }
      break
    }
    directory = dirname(directory)
  }
}
const attribution = [...notices].map(([name, license]) => `${name}\n${license}`).join("\n\n")
// HTML parsers recognize closing script tags even inside a JavaScript string.
const notice = `/*! Bundled third-party notices\n${attribution.replace(/\*\//g, "* /")}\n*/\n`
const source = `${notice}${output.text}`.replace(/<\/script/gi, "<\\/script")
await mkdir("dist", { recursive: true })
await writeFile("dist/bundle.js", `export const ADMIN_BROWSER_BUNDLE = ${JSON.stringify(source)}\n`)
await writeFile("dist/bundle.d.ts", "export declare const ADMIN_BROWSER_BUNDLE: string\n")
// The same client as an ES module, for a page that bundles it instead of pasting a document:
// `import { mount } from "@crvouga/mockingbird-admin-ui/browser"`. Nothing is evaluated from a
// string (custom panel scripts come from the embedder as real functions), so it runs under a
// Content Security Policy without 'unsafe-eval'.
const module = (
  await build({
    ...options,
    format: "esm",
    define: { ...options.define, __MOCKINGBIRD_ADMIN_COMPILES_PANELS__: "false" },
  })
).outputFiles?.[0]
if (!module) throw new Error("Admin UI build produced no module")
await writeFile("dist/browser.bundle.js", `${notice}${module.text}`)
console.log(`admin-ui: bundled React + Ant Design (${Math.round(source.length / 1024)} KiB)`)
