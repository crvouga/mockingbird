/**
 * Per-package portability gate.
 *
 * Reads the package's `mockingbird.runtime` claim (portable | node | bun) and
 * verifies the built `dist` bundle does not use APIs outside that runtime.
 *
 * An entry point can claim a different runtime in `mockingbird.entries`, keyed by its
 * dist name — `{ "server": "node", "cli": "node" }` lets a portable service ship a Node
 * listener and CLI. Each built file must then satisfy every runtime whose entry
 * reaches it through static imports, so a chunk shared with the portable main entry
 * stays portable, and only files reached solely from Node entries may use `node:*`.
 * Runs from a workspace package directory (turbo runs it where `portability`
 * is defined).
 *
 *   bun run portability        (via turbo, per package)
 */
import { existsSync } from "node:fs"
import { join } from "node:path"

const pkgDir = process.cwd()
const errors: string[] = []

function fail(message: string): void {
  errors.push(message)
  console.error(`::error::${message}`)
}

const pkgPath = join(pkgDir, "package.json")
if (!existsSync(pkgPath)) {
  console.error(`portability: no package.json in ${pkgDir}`)
  process.exit(1)
}

const pkg = JSON.parse(await Bun.file(pkgPath).text()) as {
  name?: string
  exports?: Record<string, string | { default?: string; import?: string }>
  bin?: string | Record<string, string>
  mockingbird?: { runtime?: string; entries?: Record<string, string> }
}

const name = pkg.name || "(unnamed)"
const runtime = pkg.mockingbird?.runtime ?? "portable"

if (!["portable", "node", "bun"].includes(runtime)) {
  fail(
    `${name}: mockingbird.runtime must be one of portable | node | bun (got ${JSON.stringify(runtime)})`,
  )
}

type Pattern = { label: string; test: (text: string) => boolean }

const forbiddenByRuntime: Record<string, Pattern[]> = {
  portable: [
    { label: '"from node:…"', test: (t) => /from\s+["']node:/.test(t) },
    { label: '"from bun:…"', test: (t) => /from\s+["']bun:/.test(t) },
    {
      label: 'dynamic import("node:…|bun:…")',
      test: (t) => /import\s*\(\s*["'](?:node|bun):/.test(t),
    },
    { label: '"node:/bun:" literal import', test: (t) => /["'](?:node|bun):/.test(t) },
    { label: "require()", test: (t) => /\brequire\s*\(/.test(t) },
    { label: "process.", test: (t) => /\bprocess\s*\./.test(t) },
    { label: "Bun.", test: (t) => /\bBun\s*\./.test(t) },
    { label: "Deno.", test: (t) => /\bDeno\s*\./.test(t) },
    { label: "__dirname", test: (t) => /\b__dirname\b/.test(t) },
    { label: "__filename", test: (t) => /\b__filename\b/.test(t) },
    { label: "module.exports", test: (t) => /\bmodule\.exports\b/.test(t) },
  ],
  node: [
    { label: '"from bun:…"', test: (t) => /from\s+["']bun:/.test(t) },
    { label: '"bun:" literal import', test: (t) => /["']bun:/.test(t) },
    { label: "Bun.", test: (t) => /\bBun\s*\./.test(t) },
    { label: "Deno.", test: (t) => /\bDeno\s*\./.test(t) },
  ],
  bun: [
    { label: "Deno.", test: (t) => /\bDeno\s*\./.test(t) },
    { label: '"from deno:…"', test: (t) => /from\s+["']deno:/.test(t) },
  ],
}

const distDir = join(pkgDir, "dist")
if (!existsSync(distDir)) {
  fail(`${name}: no dist/ — build first (bun run build) so portability can be checked`)
}

for (const [entry, claim] of Object.entries(pkg.mockingbird?.entries ?? {})) {
  if (!["portable", "node", "bun"].includes(claim)) {
    fail(`${name}: mockingbird.entries.${entry} must be portable | node | bun (got ${claim})`)
  }
}

let scanned = 0

function checkEntry(rel: string, text: string, runtimes: Set<string>): void {
  scanned++
  for (const claim of runtimes) {
    for (const pattern of forbiddenByRuntime[claim] ?? []) {
      if (pattern.test(text)) {
        fail(`${name}: ${rel} is not ${claim}-portable (uses ${pattern.label})`)
        return
      }
    }
  }
}

const entryRuntimes = pkg.mockingbird?.entries ?? {}
console.log(
  `portability: ${name} (runtime=${runtime}${
    Object.keys(entryRuntimes).length > 0
      ? `; ${Object.entries(entryRuntimes)
          .map(([e, r]) => `${e}=${r}`)
          .join(", ")}`
      : ""
  })`,
)

const files = new Map<string, string>()
for (const rel of new Bun.Glob("dist/**/*.js").scanSync({ cwd: pkgDir })) {
  files.set(rel.replaceAll("\\", "/"), await Bun.file(join(pkgDir, rel)).text())
}

/** Relative static and dynamic imports of a built file, as dist-relative paths. */
const RELATIVE_IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g
const importsOf = (rel: string): string[] => {
  const dir = rel.split("/").slice(0, -1)
  return [...(files.get(rel) ?? "").matchAll(RELATIVE_IMPORT)].map((m) => {
    const parts = [...dir]
    for (const segment of (m[1] as string).split("/")) {
      if (segment === "..") parts.pop()
      else if (segment !== ".") parts.push(segment)
    }
    return parts.join("/")
  })
}

const entryTargets = [
  ...Object.values(pkg.exports ?? {}).map((target) =>
    typeof target === "string" ? target : (target.default ?? target.import),
  ),
  ...(typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin ?? {})),
]
  .filter((target): target is string => typeof target === "string" && target.endsWith(".js"))
  .map((target) => target.replace(/^\.\//, ""))

// Every runtime whose entry reaches a file, through static imports, must accept it.
const required = new Map<string, Set<string>>()
for (const target of new Set(entryTargets)) {
  const entryName = target.replace(/^dist\//, "").replace(/\.js$/, "")
  const claim = entryRuntimes[entryName] ?? runtime
  const queue = [target]
  const seen = new Set<string>()
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    if (seen.has(next) || !files.has(next)) continue
    seen.add(next)
    const set = required.get(next) ?? new Set<string>()
    set.add(claim)
    required.set(next, set)
    queue.push(...importsOf(next))
  }
}

for (const [rel, text] of files) {
  checkEntry(rel, text, required.get(rel) ?? new Set([runtime]))
}

if (scanned === 0) {
  fail(`${name}: no .js files under dist/ to check for portability`)
}

if (errors.length > 0) {
  console.error("")
  console.error(`portability FAILED (${errors.length}) — fix the issues above.`)
  process.exit(1)
}

console.log(`portability: ${name} OK (${scanned} file${scanned === 1 ? "" : "s"} checked)`)
