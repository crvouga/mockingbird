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

/**
 * Subpath exports read from source too. The design system's React components and page document
 * are what most stories draw with; its stylesheet (`/styles`, `/styles.css`) is compiled, so it
 * still comes from `dist` (`bun run --cwd packages/ui build`).
 */
const SUBPATHS: Record<string, string> = {
  "@crvouga/mockingbird-ui/react": "packages/ui/src/react/index.ts",
  "@crvouga/mockingbird-ui/react/server": "packages/ui/src/react/server.tsx",
  "@crvouga/mockingbird-ui/react/client": "packages/ui/src/react/client.tsx",
  "@crvouga/mockingbird-ui/document": "packages/ui/src/document.ts",
}

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
  for (const [name, path] of Object.entries(SUBPATHS)) entries[name] = join(REPO_ROOT, path)
  return entries
}
