/**
 * Build a published mock-service package as a self-contained bundle.
 *
 * Services and the neutral `@crvouga/mockingbird-fleet` tool ship to npm; the helper workspace
 * packages they build on (core, service runtime, openapi, commands, …) are private.
 * So each service inlines them: every import that is not a declared `dependency` /
 * `peerDependency` of the service is bundled into its `dist`, JavaScript with esbuild
 * and declarations with rollup-plugin-dts. check:boundaries keeps private packages
 * out of a public package's `dependencies`.
 *
 * Runs from the package directory; one entry per `exports` subpath and per `bin` target
 * (./dist/x.js ← src/x.ts). A bin gets no declarations, and keeps its `#!` line.
 *
 *   bun ../../../scripts/bundle-service.ts
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { join, relative } from "node:path"
import { $ } from "bun"
import { build } from "esbuild"
import { rollup } from "rollup"
import { dts } from "rollup-plugin-dts"
import { adminBrandDefine } from "./admin-brand.ts"
import { VERSION_PLACEHOLDER } from "./bundle-service-version.ts"

const pkgDir = process.cwd()
const pkg = JSON.parse(await Bun.file(join(pkgDir, "package.json")).text()) as {
  name: string
  exports: Record<string, { types: string; default: string }>
  bin?: string | Record<string, string>
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  mockingbird?: { runtime?: string }
}

const external = [...Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies })]
const BUILTIN = /^(?:(?:node|bun):|bun$)/
const isBare = (id: string) => !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("\0")
const packageRoot = (id: string) =>
  id
    .split("/")
    .slice(0, id.startsWith("@") ? 2 : 1)
    .join("/")
/** Private workspace helpers are inlined; every other bare import stays an import. */
const isInlined = (id: string) =>
  /^@crvouga\/mockingbird(?:-|\/|$)/.test(id) && !external.includes(packageRoot(id))

const entryName = (target: string) =>
  target
    .replace(/^\.\//, "")
    .replace(/^dist\//, "")
    .replace(/\.js$/, "")
const entries: { name: string; src: string; types: string | undefined }[] = Object.values(
  pkg.exports,
).map((target) => {
  const name = entryName(target.default)
  return { name, src: `src/${name}.ts`, types: target.types.replace(/^\.\//, "") }
})
for (const target of typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin ?? {})) {
  const name = entryName(target)
  if (!entries.some((e) => e.name === name))
    entries.push({ name, src: `src/${name}.ts`, types: undefined })
}
for (const e of entries) {
  if (!existsSync(join(pkgDir, e.src))) throw new Error(`${pkg.name}: missing entry ${e.src}`)
}

rmSync(join(pkgDir, "dist"), { recursive: true, force: true })

const js = await build({
  absWorkingDir: pkgDir,
  entryPoints: Object.fromEntries(entries.map((e) => [e.name, e.src])),
  outdir: "dist",
  bundle: true,
  splitting: entries.length > 1,
  format: "esm",
  platform: pkg.mockingbird?.runtime === "node" ? "node" : "neutral",
  mainFields: ["module", "main"],
  target: "es2022",
  sourcemap: true,
  // The unreleased placeholder; `release:publish` rewrites it to the version it publishes
  // (see UNRELEASED_VERSION in packages/service/core/src/version.ts).
  // The admin shell's vendor chip ships inside the package (scripts/admin-brand.ts), so the
  // emulator serves it from `/__admin/ui/brands.json` instead of the page calling the docs site.
  define: {
    __MOCKINGBIRD_PACKAGE_VERSION__: JSON.stringify(VERSION_PLACEHOLDER),
    ...adminBrandDefine(pkgDir),
  },
  external: [...external, "node:*", "bun", "bun:*"],
  logLevel: "warning",
  metafile: true,
})
const kept = new Set(
  Object.values(js.metafile.outputs).flatMap((o) =>
    o.imports.filter((i) => i.external).map((i) => i.path),
  ),
)

// Declarations: emit per-file with tsc, then roll each entry into one self-contained file.
const types = mkdtempSync(join(pkgDir, "dist", ".types-"))
try {
  await $`tsc -p tsconfig.build.json --emitDeclarationOnly --declarationMap false --outDir ${types}`.cwd(
    pkgDir,
  )
  // Every entry in ONE rollup, so a declaration two entries share (a class with private members,
  // say) lands once and both entries import it. Rolled per entry, each file carries its own copy
  // and TypeScript treats the copies as unrelated types (#697: `serve(createRedis())`).
  // rollup-plugin-dts warns when a shared type has no public entry re-exporting it (a consumer's
  // declaration emit could not name it, TS2742); that package keeps per-entry files instead.
  const typed = entries.filter((e) => e.types !== undefined)
  const typesPath = new Map(typed.map((e) => [e.name, relative("dist", e.types as string)]))
  const roll = async (input: Record<string, string>, onWarning: (message: string) => void) => {
    const bundle = await rollup({
      input,
      external: (id) => isBare(id) && !isInlined(id),
      plugins: [dts({ respectExternal: true, tsconfig: join(pkgDir, "tsconfig.build.json") })],
      onwarn: (warning) => onWarning(`${pkg.name}: ${warning.message}`),
    })
    try {
      const { output } = await bundle.write({
        dir: join(pkgDir, "dist"),
        format: "es",
        entryFileNames: (chunk) => typesPath.get(chunk.name) ?? `${chunk.name}.d.ts`,
        chunkFileNames: "types-[hash].d.ts",
      })
      // An import of another file of this output (an entry or a shared chunk) is internal.
      const emitted = new Set(output.map((file) => file.fileName))
      for (const chunk of output)
        if (chunk.type === "chunk")
          for (const id of chunk.imports) if (!emitted.has(id)) kept.add(id)
    } finally {
      await bundle.close()
    }
  }
  const fatal = (message: string) => {
    throw new Error(message)
  }
  const inputOf = (e: (typeof typed)[number]) => ({ [e.name]: join(types, `${e.name}.d.ts`) })
  class Unshareable extends Error {}
  try {
    if (typed.length > 1)
      await roll(Object.assign({}, ...typed.map(inputOf)), (message) => {
        throw new Unshareable(message)
      })
    else for (const e of typed) await roll(inputOf(e), fatal)
  } catch (error) {
    if (!(error instanceof Unshareable)) throw error
    for (const e of typed) await roll(inputOf(e), fatal)
  }
} finally {
  rmSync(types, { recursive: true, force: true })
}

// Whatever the bundle still imports must be installable: a declared dependency or a builtin.
for (const id of kept) {
  if (!isBare(id) || BUILTIN.test(id) || external.includes(packageRoot(id))) continue
  throw new Error(
    `${pkg.name}: dist imports "${id}", which is not in dependencies/peerDependencies`,
  )
}

console.log(`bundle-service: ${pkg.name} → ${relative(pkgDir, join(pkgDir, "dist"))}/`)
