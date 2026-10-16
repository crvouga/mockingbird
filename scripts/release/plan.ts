/**
 * Print which public packages the next release would publish, and at which versions.
 *
 *   bun run release:plan
 *   bun run release:plan -- --github-output --save release-plan.json
 *     (freeze the plan and write has_changes=… and matrix=… to $GITHUB_OUTPUT)
 */
import { appendFileSync, writeFileSync } from "node:fs"
import { $ } from "bun"
import { computePlan, root } from "./lib.ts"
import { releaseMatrix, serializePlan } from "./pipeline.ts"

const plan = await computePlan()
const saveAt = process.argv.indexOf("--save")
if (saveAt >= 0) {
  const path = process.argv[saveAt + 1]
  if (!path || path.startsWith("--")) throw new Error("--save requires a file path")
  const sha = (await $`git rev-parse HEAD`.cwd(root).quiet()).text().trim()
  writeFileSync(path, serializePlan(plan, sha))
}

if (plan.releases.length === 0) {
  console.log("release:plan: nothing to release")
} else {
  console.log(`release:plan: ${plan.releases.length} package(s) to release`)
  for (const r of plan.releases) {
    const why =
      r.bump === "initial"
        ? "initial release"
        : [
            r.commits.length > 0 ? `${r.commits.length} commit(s)` : null,
            r.dependencyUpdates.length > 0 ? `deps: ${r.dependencyUpdates.join(", ")}` : null,
          ]
            .filter(Boolean)
            .join("; ")
    const label = r.bump === "initial" ? why : `${r.bump}; ${why}`
    console.log(`  ${r.pkg.name}: ${r.previous ?? "—"} → ${r.version} (${label})`)
  }
}

if (process.argv.includes("--github-output") && process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `has_changes=${plan.releases.length > 0}\nmatrix=${JSON.stringify(releaseMatrix(plan))}\n`,
  )
}
