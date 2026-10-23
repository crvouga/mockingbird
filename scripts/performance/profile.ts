import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"

const index = process.argv.indexOf("--only")
const name = index < 0 ? "postgres/update-batch/10000" : process.argv[index + 1]
if (!name) throw new Error("Expected --only <workload>")
const directory = resolve(".performance/profiles")
await mkdir(directory, { recursive: true })
const child = Bun.spawn(
  [
    process.execPath,
    "--cpu-prof-md",
    `--cpu-prof-dir=${directory}`,
    `--cpu-prof-name=${name.replaceAll(/[^a-zA-Z0-9-]/g, "-")}.md`,
    join(import.meta.dir, "run.ts"),
    "--profile-worker",
    ...(name.startsWith("sql.js/") ? [] : ["--no-wasm"]),
    "--only",
    name,
  ],
  { stdout: "inherit", stderr: "inherit" },
)
process.exitCode = await child.exited
