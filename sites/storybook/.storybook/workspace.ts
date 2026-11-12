/**
 * The workspace packages Storybook reads from source instead of their built `dist`, so editing a
 * page, a stylesheet or a component re-renders its stories at once (HMR) with no package build.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export const REPO_ROOT = join(import.meta.dirname, "../../..")

const GROUPS = [
  "packages",
  "packages/service",
  "packages/http",
  "packages/adapters",
  "packages/examples",
]

/** `@crvouga/mockingbird-…` → its `src/index.ts`, for every package that has one. */
export function sourceEntries(): Record<string, string> {
  const entries: Record<string, string> = {}
  for (const group of GROUPS) {
    const base = join(REPO_ROOT, group)
    for (const name of readdirSync(base)) {
      const dir = join(base, name)
      const manifest = join(dir, "package.json")
      const entry = join(dir, "src/index.ts")
      if (!existsSync(manifest) || !existsSync(entry)) continue
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }
      if (pkg.name?.startsWith("@crvouga/mockingbird")) entries[pkg.name] = entry
    }
  }
  return entries
}
