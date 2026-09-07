/**
 * Workspace boundary gate.
 *
 * Runs from the repo root. Guards the intra-workspace dependency graph:
 *   1. every internal `@crvouga/mockingbird-*` dependency resolves to an
 *      actual workspace package (no dangling refs),
 *   2. the internal dependency graph is acyclic (no runtime cycles),
 *   3. a workspace package never depends on itself,
 *   4. every module import in a package's code is declared in its package.json
 *      (dependencies + peerDependencies for shipped src; plus devDependencies
 *      for tests / scripts / benchmarks).
 *
 *   bun run check:boundaries
 */
import { existsSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"

const root = join(import.meta.dir, "..")
const errors: string[] = []

function fail(message: string): void {
  errors.push(message)
  console.error(`::error::${message}`)
}

type Pkg = {
  dir: string
  name: string
  layer: string
  runtime: string
  private: boolean
  dependencies: Set<string>
  devDependencies: Set<string>
  peerDependencies: Set<string>
}

const INTERNAL = /^@crvouga\/mockingbird(?:[-/].*)?$/
const BUILTIN = /^(node|bun|deno|stream\/web|assert):/

const packages = new Map<string, Pkg>()

function collect(dir: string, out: string[]): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name === "node_modules" || entry.name === "dist") continue
    const child = join(dir, entry.name)
    if (existsSync(join(child, "package.json"))) {
      out.push(child)
    } else {
      collect(child, out)
    }
  }
}

const packageDirs: string[] = []
collect(join(root, "packages"), packageDirs)

for (const dir of packageDirs) {
  const pkg = JSON.parse(await Bun.file(join(dir, "package.json")).text()) as {
    name?: string
    private?: boolean
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    mockingbird?: { layer?: string; runtime?: string }
  }
  if (!pkg.name) continue
  packages.set(pkg.name, {
    dir,
    name: pkg.name,
    layer: pkg.mockingbird?.layer ?? "unknown",
    runtime: pkg.mockingbird?.runtime ?? "portable",
    private: pkg.private === true,
    dependencies: new Set(Object.keys(pkg.dependencies ?? {})),
    devDependencies: new Set(Object.keys(pkg.devDependencies ?? {})),
    peerDependencies: new Set(Object.keys(pkg.peerDependencies ?? {})),
  })
}

console.log(`boundaries: ${packages.size} workspace packages`)

// 1. internal deps resolve; 3. no self-dependency.
for (const pkg of packages.values()) {
  for (const depName of [...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies]) {
    if (!INTERNAL.test(depName)) continue
    if (depName === pkg.name) {
      fail(`${pkg.name} depends on itself`)
    } else if (!packages.has(depName)) {
      fail(`${pkg.name} → ${depName}: internal dependency is not a workspace package`)
    }
  }
}

// 2. acyclic internal graph.
const visiting = new Set<string>()
const visited = new Set<string>()
const stack: string[] = []
const walk = (name: string): void => {
  if (visiting.has(name)) {
    const at = stack.indexOf(name)
    fail(`dependency cycle: ${[...stack.slice(at), name].join(" → ")}`)
    return
  }
  if (visited.has(name)) return
  visiting.add(name)
  stack.push(name)
  const pkg = packages.get(name)
  if (pkg) {
    for (const dep of pkg.dependencies) {
      if (packages.has(dep)) walk(dep)
    }
  }
  stack.pop()
  visiting.delete(name)
  visited.add(name)
}
for (const name of packages.keys()) walk(name)

/**
 * Find module specifiers in TS source, ignoring specifiers that appear inside
 * string literals, template literals, or comments.
 */
function findModuleSpecifiers(text: string): string[] {
  const mask = new Array<boolean>(text.length).fill(false)
  let state: "code" | "sq" | "dq" | "bt" | "line" | "block" = "code"
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]
    if (state === "code") {
      if (c === "/" && next === "/") {
        state = "line"
        mask[i] = mask[i + 1] = true
        i++
      } else if (c === "/" && next === "*") {
        state = "block"
        mask[i] = mask[i + 1] = true
        i++
      } else if (c === "'") {
        state = "sq"
        mask[i] = true
      } else if (c === '"') {
        state = "dq"
        mask[i] = true
      } else if (c === "`") {
        state = "bt"
        mask[i] = true
      }
    } else if (state === "sq") {
      mask[i] = true
      if (c === "\\") {
        mask[i + 1] = true
        i++
      } else if (c === "'") state = "code"
    } else if (state === "dq") {
      mask[i] = true
      if (c === "\\") {
        mask[i + 1] = true
        i++
      } else if (c === '"') state = "code"
    } else if (state === "bt") {
      mask[i] = true
      if (c === "\\") {
        mask[i + 1] = true
        i++
      } else if (c === "`") state = "code"
    } else if (state === "line") {
      mask[i] = true
      if (c === "\n") state = "code"
    } else {
      mask[i] = true
      if (c === "*" && next === "/") {
        mask[i + 1] = true
        i++
        state = "code"
      }
    }
  }

  const out = new Set<string>()
  const isWordStart = (i: number): boolean => i === 0 || !/[A-Za-z0-9_$]/.test(text[i - 1])
  const readString = (qi: number): { spec: string; end: number } | null => {
    const quote = text[qi]
    if (quote !== "'" && quote !== '"') return null
    let j = qi + 1
    let spec = ""
    while (j < text.length) {
      const ch = text[j]
      if (ch === "\\") {
        spec += text[j + 1] ?? ""
        j += 2
        continue
      }
      if (ch === quote) return { spec, end: j + 1 }
      spec += ch
      j++
    }
    return null
  }

  for (let i = 0; i < text.length; i++) {
    if (mask[i]) continue
    if (!isWordStart(i)) continue
    const word = text[i]
    if (word !== "f" && word !== "r" && word !== "i") continue

    if (text.startsWith("from", i)) {
      let j = i + 4
      while (j < text.length && /\s/.test(text[j])) j++
      const found = readString(j)
      if (found) {
        out.add(found.spec)
        i = found.end
      }
    } else if (text.startsWith("require", i)) {
      let j = i + 7
      while (j < text.length && /\s/.test(text[j])) j++
      if (text[j] === "(") {
        j++
        while (j < text.length && /\s/.test(text[j])) j++
        const found = readString(j)
        if (found) {
          out.add(found.spec)
          i = found.end
        }
      }
    } else if (text.startsWith("import", i)) {
      let j = i + 6
      while (j < text.length && /\s/.test(text[j])) j++
      if (text[j] === "(") {
        j++
        while (j < text.length && /\s/.test(text[j])) j++
        const found = readString(j)
        if (found) {
          out.add(found.spec)
          i = found.end
        }
      } else if (text[j] === "'" || text[j] === '"') {
        const found = readString(j)
        if (found) {
          out.add(found.spec)
          i = found.end
        }
      }
      // named / namespace / type imports end with `from "..."` — handled above.
    }
  }
  return [...out]
}

async function resolveOwner(file: string): Promise<Pkg | null> {
  let cursor = join(root, "packages")
  const parts = relative(join(root, "packages"), file).split("/")
  for (const part of parts.slice(0, -1)) {
    cursor = join(cursor, part)
    const pkgPath = join(cursor, "package.json")
    if (existsSync(pkgPath)) {
      const name = (JSON.parse(await Bun.file(pkgPath).text()) as { name?: string }).name
      if (name && packages.has(name)) return packages.get(name) ?? null
    }
  }
  return null
}

const files: string[] = []
const glob = new Bun.Glob("packages/**/*.ts")
for (const entry of glob.scanSync({ cwd: root })) {
  if (
    entry.includes("node_modules") ||
    entry.includes("/dist/") ||
    entry.includes("/src/generated/")
  )
    continue
  files.push(join(root, entry))
}

for (const file of files) {
  const owner = await resolveOwner(file)
  if (!owner) continue
  const rel = relative(root, file)
  const inSrc = rel.split("/").includes("src")
  const text = await Bun.file(file).text()

  for (const specifier of findModuleSpecifiers(text)) {
    if (specifier === owner.name) {
      fail(`${rel} self-imports ${owner.name}`)
      continue
    }
    if (specifier.startsWith(".") || BUILTIN.test(specifier)) continue

    const isInternal = INTERNAL.test(specifier) || packages.has(specifier)
    if (isInternal && !packages.has(specifier)) {
      fail(`${rel} imports "${specifier}" which is not a workspace package`)
      continue
    }

    const allowed = inSrc
      ? new Set([...owner.dependencies, ...owner.peerDependencies])
      : new Set([...owner.dependencies, ...owner.devDependencies, ...owner.peerDependencies])

    if (!allowed.has(specifier)) {
      fail(
        `${rel} imports "${specifier}" but it is not in ${owner.name} ${inSrc ? "dependencies/peerDependencies" : "dependencies, devDependencies, or peerDependencies"}`,
      )
    }
  }
}

if (errors.length > 0) {
  console.error("")
  console.error(`check:boundaries FAILED (${errors.length}) — fix the issues above.`)
  process.exit(1)
}

console.log(`boundaries: OK (${files.length} files scanned)`)
