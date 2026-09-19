/**
 * Drop turbo cache entries the latest `turbo run --summarize` did not use, so the
 * GitHub Actions turbo cache holds exactly one run's artifacts instead of growing forever.
 *
 *   bun scripts/ci/prune-turbo-cache.ts
 */
import { readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "../..")
const cacheDir = join(root, ".turbo/cache")
const runsDir = join(root, ".turbo/runs")

const latestRun = readdirSync(runsDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => join(runsDir, f))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
if (!latestRun) {
  console.error("prune-turbo-cache: no run summary; run turbo with --summarize first")
  process.exit(1)
}

const summary = (await Bun.file(latestRun).json()) as { tasks: Array<{ hash: string }> }
const keep = new Set(summary.tasks.map((t) => t.hash))
let removed = 0
for (const file of readdirSync(cacheDir)) {
  const hash = file.split(/[-.]/)[0] ?? ""
  if (keep.has(hash)) continue
  rmSync(join(cacheDir, file), { recursive: true, force: true })
  removed++
}
console.log(`prune-turbo-cache: kept ${keep.size} task(s), removed ${removed} file(s)`)
