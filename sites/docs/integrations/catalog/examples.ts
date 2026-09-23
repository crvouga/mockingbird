import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"

export type ExampleDefinition = {
  id: string
  title: string
  description: string
  entry: string
  sources?: string[]
}

/** Service-owned examples are explicit metadata, never inferred from filenames. */
export function readExamples(value: unknown, serviceDir: string): ExampleDefinition[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error("mockingbird.examples must be an array")
  const ids = new Set<string>()
  const file = (path: unknown): string => {
    if (typeof path !== "string" || !path.startsWith("examples/") || isAbsolute(path))
      throw new Error("Example files must be inside the service's examples/ directory")
    const target = resolve(serviceDir, path)
    if (!existsSync(target) || !statSync(target).isFile())
      throw new Error(`Missing example file: ${path}`)
    const rel = relative(realpathSync(resolve(serviceDir, "examples")), realpathSync(target))
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error(`Example path escapes examples/: ${path}`)
    return path
  }
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("Example must be an object")
    const v = raw as Record<string, unknown>
    if (typeof v.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(v.id) || ids.has(v.id))
      throw new Error("Example id must be unique and kebab-case")
    ids.add(v.id)
    for (const name of ["title", "description"])
      if (typeof v[name] !== "string" || !String(v[name]).trim())
        throw new Error(`Example ${v.id} requires ${name}`)
    const entry = file(v.entry)
    if (!/\.(ts|js)$/.test(entry))
      throw new Error("Example entry must be a TypeScript or JavaScript module exporting mount")
    if (v.sources !== undefined && !Array.isArray(v.sources))
      throw new Error("Example sources must be an array")
    const sources = (v.sources as unknown[] | undefined)?.map(file) ?? [entry]
    return { id: v.id, title: String(v.title), description: String(v.description), entry, sources }
  })
}

export function exampleSource(serviceDir: string, path: string): string {
  return readFileSync(resolve(serviceDir, path), "utf8")
}
