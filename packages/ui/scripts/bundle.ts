/**
 * Prebuild a package's React UI for pages a runtime serves as strings (emulator sign-in, consent
 * and pairing pages, inspectors, reports, harnesses). Two outputs, both in `dist-ui/` (gitignored,
 * a turbo build output, and untouched by the package's own `dist` build):
 *
 *   --ssr src/ui/server.tsx      → dist-ui/server.js
 *       The entry and everything it imports (React, react-dom/server, HeroUI, the shared
 *       components) as one minified ES module with the same exports. Portable: no Node API, no
 *       `process`, no CommonJS left, so it passes `bun run portability` inside a service's dist.
 *       `@crvouga/mockingbird-ui/styles` stays an import, so the stylesheet is not copied into
 *       every page module.
 *
 *   --client src/ui/client.tsx --global MockingbirdOAuth   → dist-ui/client.bundle.js (+ .d.ts)
 *       A browser IIFE that assigns the entry's exports to `globalThis.MockingbirdOAuth`, held as
 *       the string `BUNDLE`, for `renderDocument({ script: { source: BUNDLE, call: … } })`.
 *
 * Third-party license notices ride inside both. The runtime reaches the SSR module only through
 * a dynamic `import()`, so React is never on its hot path. Run from the consuming package
 * directory, as part of its build (see packages/ui/README.md, "Pages served as strings"):
 *
 *   bun ../../../packages/ui/scripts/bundle.ts --ssr src/ui/server.tsx --client src/ui/client.tsx --global MockingbirdOAuth
 *
 * Imports resolve from the entry's package, which therefore declares react, react-dom,
 * @heroui/react and @crvouga/mockingbird-ui itself.
 */
import { mkdir, rm, writeFile } from "node:fs/promises"
import { basename, extname, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { type BuildOptions, build, type Metafile } from "esbuild"
import { collectNotices, noticeComment } from "./notices.ts"

export const OUT_DIR = "dist-ui"

export type BundleOptions = {
  /** Server-rendering entry (exports functions returning HTML), relative to `cwd`. */
  ssr?: string
  /** Browser entry (exports the functions a page calls to mount or hydrate), relative to `cwd`. */
  client?: string
  /** The global the client bundle assigns its exports to. Required with `client`. */
  global?: string
  /** Default: the current directory. */
  cwd?: string
  /** Skip minification, for reading the output. Not portable (`module.exports` remains). */
  debug?: boolean
}

export type BundleOutput = { file: string; bytes: number; packages: string[] }

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
const STYLES = "@crvouga/mockingbird-ui/styles"

const shared = (debug: boolean): BuildOptions => ({
  bundle: true,
  target: "es2022",
  jsx: "automatic",
  minify: !debug,
  // Licenses are collected per package below; esbuild's per-file comments would repeat them.
  legalComments: "none",
  // React picks its build from process.env.NODE_ENV and probes `typeof process`; nothing in a
  // page may reach for Node's process, so both fold away. Minifying also renames the CommonJS
  // wrappers' `module`, so no `module.exports` is left for the portability check to flag.
  define: { "process.env.NODE_ENV": '"production"', process: "undefined" },
  write: false,
  metafile: true,
  logLevel: "warning",
})

const notices = async (cwd: string, metafile: Metafile | undefined) => {
  if (!metafile) throw new Error("esbuild returned no metafile")
  return collectNotices(Object.keys(metafile.inputs).map((input) => resolve(cwd, input)))
}

const outName = (entry: string) => basename(entry, extname(entry))

export async function bundle(options: BundleOptions): Promise<BundleOutput[]> {
  const cwd = options.cwd ?? process.cwd()
  const debug = options.debug ?? false
  const outputs: BundleOutput[] = []
  await mkdir(join(cwd, OUT_DIR), { recursive: true })

  if (options.ssr) {
    const result = await build({
      ...shared(debug),
      absWorkingDir: cwd,
      entryPoints: [options.ssr],
      // "browser" picks the builds of React and its dependencies that need no Node API; the
      // module runs in every runtime (Node, Bun, Deno, Workers, browsers).
      platform: "browser",
      format: "esm",
      external: [STYLES],
    })
    const output = result.outputFiles?.[0]
    if (!output) throw new Error(`${options.ssr}: esbuild produced no output`)
    const found = await notices(cwd, result.metafile)
    const file = join(cwd, OUT_DIR, `${outName(options.ssr)}.js`)
    const text = `${noticeComment("Bundled third-party notices", found)}${output.text}`
    await rm(file, { force: true })
    await writeFile(file, text)
    outputs.push({ file, bytes: text.length, packages: [...found.keys()] })
  }

  if (options.client) {
    const global = options.global
    if (!global || !IDENTIFIER.test(global))
      throw new Error("--client needs --global <Identifier>, the name the page calls it by")
    const result = await build({
      ...shared(debug),
      absWorkingDir: cwd,
      entryPoints: [options.client],
      platform: "browser",
      format: "iife",
      globalName: global,
    })
    const output = result.outputFiles?.[0]
    if (!output) throw new Error(`${options.client}: esbuild produced no output`)
    const found = await notices(cwd, result.metafile)
    const source = `${noticeComment("Bundled third-party notices", found)}${output.text}`
    const base = join(cwd, OUT_DIR, `${outName(options.client)}.bundle`)
    await writeFile(
      `${base}.js`,
      `/** Built by packages/ui/scripts/bundle.ts from ${options.client}: defines \`${global}\`. */\nexport const BUNDLE = ${JSON.stringify(source)}\n`,
    )
    await writeFile(`${base}.d.ts`, "export declare const BUNDLE: string\n")
    outputs.push({ file: `${base}.js`, bytes: source.length, packages: [...found.keys()] })
  }
  return outputs
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      ssr: { type: "string" },
      client: { type: "string" },
      global: { type: "string" },
      debug: { type: "boolean" },
    },
  })
  if (!values.ssr && !values.client) {
    console.error(
      "usage: bun packages/ui/scripts/bundle.ts [--ssr src/ui/server.tsx] [--client src/ui/client.tsx --global Name] [--debug]",
    )
    process.exit(2)
  }
  const done = await bundle({
    ...(values.ssr ? { ssr: values.ssr } : {}),
    ...(values.client ? { client: values.client } : {}),
    ...(values.global ? { global: values.global } : {}),
    ...(values.debug ? { debug: true } : {}),
  })
  for (const output of done)
    console.log(
      `bundle: ${join(OUT_DIR, basename(output.file))} (${Math.round(output.bytes / 1024)} KiB, ${output.packages.length} packages)`,
    )
}
