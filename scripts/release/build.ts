/** Build just this job's planned packages. Turbo brings their build dependencies along. */
import { root } from "./lib.ts"
import { pipelineOptions, readPlan, selectReleases } from "./pipeline.ts"

const options = pipelineOptions(process.argv.slice(2))
if (!options) throw new Error("release build requires --plan and --group")
const releases = selectReleases(await readPlan(options.path), options.group)
if (releases.length > 0) {
  const args = releases.map((r) => `--filter=${r.pkg.name}`)
  const proc = Bun.spawn(["bunx", "turbo", "run", "build", ...args, "--output-logs=errors-only"], {
    cwd: root,
    stdio: ["inherit", "inherit", "inherit"],
  })
  process.exit(await proc.exited)
}
