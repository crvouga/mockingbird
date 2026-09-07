/**
 * Per-package portability gate.
 *
 * Reads the package's `mockingbird.runtime` claim (portable | node | bun) and
 * verifies the built `dist` bundle does not use APIs outside that runtime.
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
  mockingbird?: { runtime?: string }
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

const forbidden = forbiddenByRuntime[runtime] ?? []
let scanned = 0

function checkEntry(rel: string, text: string): void {
  scanned++
  for (const pattern of forbidden) {
    if (pattern.test(text)) {
      fail(`${name}: ${rel} is not ${runtime}-portable (uses ${pattern.label})`)
      return
    }
  }
}

console.log(`portability: ${name} (runtime=${runtime})`)
const distJs = join(pkgDir, "dist/index.js")
if (existsSync(distJs)) {
  checkEntry(join("dist", "index.js"), await Bun.file(distJs).text())
}
const glob = new Bun.Glob("dist/**/*.js")
for (const entry of glob.scanSync({ cwd: pkgDir })) {
  const abs = join(pkgDir, entry)
  if (abs === distJs) continue
  checkEntry(entry, await Bun.file(abs).text())
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
