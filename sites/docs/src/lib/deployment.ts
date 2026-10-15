import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs"
import { join } from "node:path"

export const SOURCE_ROOTS = ["packages", "scripts", "docs", "sites/docs"] as const
const ROOT_FILES = [
  "package.json",
  "bun.lock",
  "turbo.json",
  "tsconfig.base.json",
  "biome.json",
  ".dockerignore",
  "llms.txt",
]
const ARTIFACTS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".turbo",
  ".astro",
  ".cache",
  "coverage",
  "__pycache__",
  ".webhook-events",
  "playwright-report",
  "test-results",
])
export type SourceFile = { path: string; sha: string }
export type DeploymentManifest = {
  schemaVersion: 1
  service: "mockingbird-docs"
  algorithm: "sha256-git-blobs-v1"
  fingerprint: string
  files: number
}

/** One source selection for the Docker build and the remote Git tree comparison. */
export function isSourceInput(path: string): boolean {
  const parts = path.split("/")
  if (parts.some((part) => ARTIFACTS.has(part))) return false
  const name = parts.at(-1) ?? ""
  if (
    name.startsWith(".env") ||
    name === ".DS_Store" ||
    /\.(log|tgz|tsbuildinfo|pyc)$/.test(name) ||
    name.endsWith(".tmp.ts")
  )
    return false
  if (/^packages\/service\/[^/]+\/CHANGELOG\.md$/.test(path)) return false
  if (/\/compat\/(requirements\.raw\.html|gate-report\.json)$/.test(path)) return false
  if (
    /\/benchmarks\/results\/[^/]+\.(json|html)$/.test(path) &&
    !["schema.example.json", "ci-baseline.json", "throttle-baseline.json"].includes(name)
  )
    return false
  return ROOT_FILES.includes(path) || SOURCE_ROOTS.some((root) => path.startsWith(`${root}/`))
}

export function sourceManifest(files: SourceFile[]): DeploymentManifest {
  const selected = files
    .filter((file) => isSourceInput(file.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(selected.map(({ path, sha }) => [path, sha])))
    .digest("hex")
  return {
    schemaVersion: 1,
    service: "mockingbird-docs",
    algorithm: "sha256-git-blobs-v1",
    fingerprint,
    files: selected.length,
  }
}

/** Node-only, runs while Astro builds. No secrets, git executable, or .git directory needed. */
export function localSourceManifest(root: string): DeploymentManifest {
  const files: SourceFile[] = []
  const add = (path: string, symlink = false) => {
    if (!isSourceInput(path)) return
    const bytes = symlink
      ? Buffer.from(readlinkSync(join(root, path)))
      : readFileSync(join(root, path))
    const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
    files.push({ path, sha })
  }
  const walk = (path: string) => {
    if (!existsSync(join(root, path))) return
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      if (ARTIFACTS.has(entry.name)) continue
      const child = `${path}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else if (entry.isFile() || entry.isSymbolicLink()) add(child, entry.isSymbolicLink())
    }
  }
  for (const path of SOURCE_ROOTS) walk(path)
  for (const path of ROOT_FILES) if (existsSync(join(root, path))) add(path)
  return sourceManifest(files)
}
