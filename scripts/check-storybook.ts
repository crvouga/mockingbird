/**
 * Every piece of UI is in the catalog. A source file draws UI when it is a docs-site page or
 * layout, a React component of the admin UI, a Fleet Cloud or notifications UI module, or code that
 * writes an HTML document or answers `text/html`. Each must be catalogued:
 *
 *   - named in a story's `parameters.sources` (sites/storybook/stories), or
 *   - imported by a story file directly, or
 *   - for the Fleet Cloud and notifications Storybooks, which mount their whole UI, reached through
 *     their stories' imports.
 *
 * Files that match the signal without drawing anything a person sees are listed in NOT_UI with
 * the reason. Run: bun run check:storybook
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

const root = join(import.meta.dir, "..")
const rel = (path: string) => relative(root, path).split("\\").join("/")

/** Matches the signal, draws no UI. */
const NOT_UI: Record<string, string> = {
  "packages/service/core/src/aws-xml.ts": "XML response bodies",
  "packages/service/s3/src/goxml.ts": "XML response bodies",
  "packages/service/s3/src/bucket-config/goxml.ts": "XML response bodies",
  "packages/notifications/src/mime.ts": "parses MIME parts of recorded email",
  "packages/notifications/src/harness.ts": "serves the bundle that stories already mount",
  "packages/examples/medical-testing/src/composition/buildClientAssets.ts":
    "bundles the client the example's stories run",
  "packages/http/provider/src/vendor/core/http.ts": "response helpers the vendor pages call",
  "packages/service/s3/src/mimedb.generated.ts": "a table of MIME types",
  "packages/http/provider/src/vendor/google/helpers.ts": "Gmail message and MIME data, no page",
  "packages/http/provider/src/vendor/vercel/routes/blob.ts": "a JSON and blob API, no page",
  "packages/service/vercel-blob/src/state.ts": "a table of file extensions and content types",
  "packages/notifications/src/ui/browser.ts":
    "the harness page's entry script; mounts the dashboard its Harness/Dashboard stories draw",
  "sites/fleet/src/ui/app.ts": "the dashboard's entry script; mounts the router its stories draw",
  "packages/service/sqlite/benchmarks/durability-browser.ts":
    "a dev-only benchmark page served with sql.js WebAssembly beside it; run it with bun",
}

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "generated",
  "test",
  "tests",
  "e2e",
  "scripts",
  "oracle",
  "upstream",
  "specs",
  "storybook-static",
  "stories",
  ".turbo",
  ".tmp",
  "benchmarks-out",
])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name) && !name.startsWith(".")) walk(path, out)
    } else out.push(path)
  }
  return out
}

const HTML = /<!doctype html|<html[\s>]|["'`]text\/html/i
const isTest = (path: string) => /\.(test|spec|e2e)\.tsx?$/.test(path)

const candidates = [
  ...walk(join(root, "packages")).filter(
    (path) =>
      !isTest(path) &&
      ((path.endsWith(".tsx") && rel(path).startsWith("packages/admin-ui/src/")) ||
        (/\.tsx?$/.test(path) && HTML.test(readFileSync(path, "utf8")))),
  ),
  // Reports render HTML from benchmark runs; they live under benchmarks/ but are UI.
  ...["packages/service/postgres", "packages/service/sqlite"].map((dir) =>
    join(root, dir, "benchmarks/harness/html-report.ts"),
  ),
  ...walk(join(root, "sites/docs/src/pages")).filter((path) => path.endsWith(".astro")),
  join(root, "sites/docs/src/layouts/Base.astro"),
  ...walk(join(root, "sites/fleet/src/ui")).filter((path) => /\.ts$/.test(path) && !isTest(path)),
  ...walk(join(root, "packages/notifications/src/ui")).filter(
    (path) => /\.ts$/.test(path) && !isTest(path),
  ),
].filter((path) => existsSync(path))

const surfaces = [...new Set(candidates.map(rel))].filter((path) => !(path in NOT_UI)).sort()

// ---- what the stories reach

const IMPORT = /(?:import|export)[^"'`]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g

function resolveImport(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined
  const base = resolve(dirname(from), specifier)
  for (const candidate of [
    base,
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
  ])
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  return undefined
}

const importsOf = (file: string) =>
  [...readFileSync(file, "utf8").matchAll(IMPORT)]
    .map((match) => resolveImport(file, (match[1] ?? match[2]) as string))
    .filter((path): path is string => path !== undefined)

const catalogued = new Set<string>()

const hub = join(root, "sites/storybook/stories")
const hubFiles = existsSync(hub) ? walk(hub).filter((path) => path.endsWith(".ts")) : []
for (const file of hubFiles) {
  const text = readFileSync(file, "utf8")
  for (const imported of importsOf(file)) catalogued.add(rel(imported))
  // `sources: [...]`, and any other repo path a story names as what it draws.
  for (const match of text.matchAll(/["'`]((?:packages|sites)\/[^"'`\s]+\.(?:tsx?|astro))["'`]/g)) {
    const path = match[1] as string
    if (!existsSync(join(root, path))) {
      console.error(`::error file=${rel(file)}::names ${path}, which does not exist`)
      process.exitCode = 1
    }
    catalogued.add(path)
  }
}

/** The Storybooks that mount a whole app: everything their stories reach inside the package. */
for (const [stories, scope] of [
  ["sites/fleet/src/ui/stories", "sites/fleet/src"],
  ["packages/notifications/stories", "packages/notifications/src"],
] as const) {
  const queue = walk(join(root, stories)).filter((path) => path.endsWith(".ts"))
  const seen = new Set<string>()
  while (queue.length) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    catalogued.add(rel(file))
    for (const imported of importsOf(file))
      if (rel(imported).startsWith(scope) || rel(imported).startsWith(stories)) queue.push(imported)
  }
}

const missing = surfaces.filter((path) => !catalogued.has(path))
for (const path of missing)
  console.error(
    `::error file=${path}::draws UI but no story catalogues it (sites/storybook/README.md)`,
  )
for (const path of Object.keys(NOT_UI))
  if (!existsSync(join(root, path))) {
    console.error(`::error::NOT_UI lists ${path}, which no longer exists`)
    process.exitCode = 1
  }
console.log(
  `${surfaces.length - missing.length}/${surfaces.length} UI source files are in the catalog`,
)
if (missing.length) process.exitCode = 1
