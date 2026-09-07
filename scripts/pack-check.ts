/**
 * Per-package integrity gate for anything that ships to npm.
 *
 * Runs from a workspace package directory (turbo runs it where `pack:check`
 * is defined). Verifies build outputs, npm pack contents, ESM resolution with
 * arethetypeswrong, and publint. Publish-only assertions (provenance, files,
 * repository) apply to packages with `publishConfig.access === "public"`.
 *
 *   bun run pack:check        (via turbo, per package)
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { $ } from "bun"

const pkgDir = process.cwd()
const errors: string[] = []

function fail(message: string): void {
  errors.push(message)
  console.error(`::error::${message}`)
}

async function tryReadJson<T>(rel: string): Promise<T | null> {
  const abs = join(pkgDir, rel)
  if (!existsSync(abs)) return null
  return JSON.parse(await Bun.file(abs).text()) as T
}

const pkg = await tryReadJson<{
  name: string
  version: string
  private?: boolean
  type?: string
  files?: string[]
  exports?: Record<string, { types?: string; default?: string; import?: string }>
  bin?: string | Record<string, string>
  repository?: { url?: string }
  publishConfig?: { access?: string; provenance?: boolean }
  mockingbird?: { runtime?: string; layer?: string }
}>("package.json")

if (!pkg) {
  console.error(`pack-check: no package.json in ${pkgDir}`)
  process.exit(1)
}

const isPublic = pkg.publishConfig?.access === "public"
const isPrivate = pkg.private === true
const name = pkg.name || "(unnamed)"

console.log(
  `pack-check: ${name}@${pkg.version}${isPublic ? " (public)" : isPrivate ? " (private)" : ""}`,
)

if (pkg.type !== "module") {
  fail(`${name}: package.json must set "type": "module" (ESM-only)`)
}

// --- dist & exports ---
const distJs = "dist/index.js"
const distDts = "dist/index.d.ts"
if (!existsSync(join(pkgDir, distJs)))
  fail(`${name}: missing ${distJs} — build first (bun run build)`)
if (!existsSync(join(pkgDir, distDts)))
  fail(`${name}: missing ${distDts} — build first (bun run build)`)

const exportEntry = pkg.exports?.["."]
if (!exportEntry) {
  fail(`${name}: package.json exports["."] must exist`)
} else if (!exportEntry.types) {
  fail(`${name}: exports["."].types must be set (ship .d.ts)`)
} else {
  const typesRel = exportEntry.types.replace(/^\.\//, "")
  if (!existsSync(join(pkgDir, typesRel))) {
    fail(`${name}: exports["."].types points at ${typesRel} which does not exist`)
  }
}

if (exportEntry && (exportEntry.default || exportEntry.import)) {
  const mainRel = (exportEntry.default || exportEntry.import).replace(/^\.\//, "")
  if (!existsSync(join(pkgDir, mainRel))) {
    fail(
      `${name}: exports["."].${exportEntry.default ? "default" : "import"} points at ${mainRel} which does not exist`,
    )
  }
}

if (pkg.bin) {
  const binRel = typeof pkg.bin === "string" ? pkg.bin : (Object.values(pkg.bin)[0] ?? "")
  if (binRel && !existsSync(join(pkgDir, binRel.replace(/^\.\//, "")))) {
    fail(`${name}: bin ${binRel} does not exist`)
  }
}

// --- publish-only assertions ---
if (isPublic) {
  if (!pkg.repository?.url) {
    fail(
      `${name}: publishConfig.access is public but repository.url is missing (npm + GitHub need it)`,
    )
  }
  if (!Array.isArray(pkg.files) || !pkg.files.includes("dist")) {
    fail(`${name}: package.json "files" must include "dist" so the tarball ships the build`)
  }
  if (pkg.publishConfig?.provenance !== true) {
    fail(
      `${name}: publishConfig.provenance should be true for npm Trusted Publishing (OIDC) rebuilds`,
    )
  }
}

// --- dist homogeneity / portability ---
// A `portable` public package must not ship Node/Bun-only API usage in its ESM.
const runtime = pkg.mockingbird?.runtime
if (isPublic && runtime === "portable") {
  const bundle = existsSync(join(pkgDir, distJs)) ? await Bun.file(join(pkgDir, distJs)).text() : ""
  for (const label of [
    { label: 'from "node:…"', test: (t: string) => /from\s+["']node:/.test(t) },
    { label: 'from "bun:…"', test: (t: string) => /from\s+["']bun:/.test(t) },
    { label: 'import("node:…")', test: (t: string) => /import\s*\(\s*["']node:/.test(t) },
    { label: 'import("bun:…")', test: (t: string) => /import\s*\(\s*["']bun:/.test(t) },
    { label: "require()", test: (t: string) => /\brequire\s*\(/.test(t) },
    { label: "process.", test: (t: string) => /\bprocess\s*\./.test(t) },
    { label: "Bun.", test: (t: string) => /\bBun\s*\./.test(t) },
    { label: "Deno.", test: (t: string) => /\bDeno\s*\./.test(t) },
    { label: "__dirname", test: (t: string) => /\b__dirname\b/.test(t) },
    { label: "__filename", test: (t: string) => /\b__filename\b/.test(t) },
    { label: "module.exports", test: (t: string) => /\bmodule\.exports\b/.test(t) },
    { label: "WebAssembly", test: (t: string) => /\bWebAssembly\b/.test(t) },
  ]) {
    if (label.test(bundle)) {
      fail(
        `${name}: dist/index.js contains Node/Bun-only pattern (${label.label}); keep the build isomorphic`,
      )
    }
  }
}

// --- npm pack (dry list) ---
const pack = await $`npm pack --dry-run --json --ignore-scripts`.cwd(pkgDir).quiet().nothrow()
if (pack.exitCode !== 0) {
  fail(`${name}: npm pack --dry-run failed — the package cannot be packed for npm`)
} else {
  let entries: Array<{ filename?: string; files?: Array<{ path: string }> }>
  try {
    const raw = pack.stdout.toString().trim()
    const jsonStart = raw.indexOf("[")
    entries = JSON.parse(jsonStart >= 0 ? raw.slice(jsonStart) : raw)
  } catch (err) {
    fail(
      `${name}: npm pack --dry-run returned invalid JSON (${err instanceof Error ? err.message : String(err)})`,
    )
    entries = []
  }
  const files = entries[0]?.files?.map((f) => f.path) ?? []
  for (const needed of ["dist/index.js", "dist/index.d.ts", "package.json"]) {
    if (!files.some((p) => p === needed || p.endsWith(`/${needed}`))) {
      fail(
        `${name}: npm tarball is missing ${needed}. Check package.json "files" and the build output.`,
      )
    }
  }
  if (files.length < 5) {
    fail(`${name}: npm tarball looks empty (${files.length} files). Refusing to publish.`)
  } else {
    console.log(`pack-check: tarball would include ${files.length} files`)
  }
}

// --- publint ---
const publint = await $`bunx publint`.cwd(pkgDir).nothrow()
if (publint.exitCode !== 0) {
  fail(`${name}: publint reported packaging problems — see output above`)
}

// --- arethetypeswrong (ESM-only consumer resolution) ---
const attw = await $`bunx --bun attw --pack . --profile esm-only`.cwd(pkgDir).nothrow()
if (attw.exitCode !== 0) {
  fail(`${name}: arethetypeswrong reported type-packaging problems — see output above`)
}

if (errors.length > 0) {
  console.error("")
  console.error(`pack-check FAILED (${errors.length}) — fix the issues above.`)
  console.error("Run: bun run build && bun run pack:check")
  process.exit(1)
}

console.log(`pack-check: ${name} OK`)
