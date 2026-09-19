/**
 * Build a published mock-service package as a self-contained bundle.
 *
 * Only `@crvouga/mockingbird-service-*` packages ship to npm; the helper workspace
 * packages they build on (core, service runtime, openapi, commands, …) are private.
 * So each service inlines them: every import that is not a declared `dependency` /
 * `peerDependency` of the service is bundled into its `dist`, JavaScript with esbuild
 * and declarations with rollup-plugin-dts. check:boundaries keeps private packages
 * out of a public package's `dependencies`.
 *
 * Runs from the package directory; one entry per `exports` subpath (./dist/x.js ← src/x.ts).
 *
 *   bun ../../../scripts/bundle-service.ts
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { join, relative } from "node:path"
import { $ } from "bun"
import { build } from "esbuild"
import { rollup } from "rollup"
import { dts } from "rollup-plugin-dts"

const pkgDir = process.cwd()
const pkg = JSON.parse(await Bun.file(join(pkgDir, "package.json")).text()) as {
  name: string
  exports: Record<string, { types: string; default: string }>
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

const entries = Object.values(pkg.exports).map((target) => {
  const out = target.default.replace(/^\.\//, "")
  const name = out.replace(/^dist\//, "").replace(/\.js$/, "")
  return { name, src: `src/${name}.ts`, types: target.types.replace(/^\.\//, "") }
})
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
const types = mkdtempSync(join(pkgDir, ".types-"))
try {
  await $`tsc -p tsconfig.build.json --emitDeclarationOnly --declarationMap false --outDir ${types}`.cwd(
    pkgDir,
  )
  for (const e of entries) {
    const bundle = await rollup({
      input: join(types, `${e.name}.d.ts`),
      external: (id) => isBare(id) && !isInlined(id),
      plugins: [dts({ respectExternal: true, tsconfig: join(pkgDir, "tsconfig.build.json") })],
      onwarn: (warning) => {
        throw new Error(`${pkg.name}: ${warning.message}`)
      },
    })
    const { output } = await bundle.write({ file: join(pkgDir, e.types), format: "es" })
    for (const chunk of output)
      if (chunk.type === "chunk") for (const id of chunk.imports) kept.add(id)
    await bundle.close()
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
