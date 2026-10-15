import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { checks } from "./checks.ts"
import { readReports } from "./cli.ts"
import { safeError } from "./io.ts"
import { type HealthReport, needsAttention, renderHealth, report } from "./report.ts"

const id = process.argv[2]
const directory = process.env.MOCKINGBIRD_HEALTH_REPORT_DIR
if (id === "--summary") {
  if (!directory || !existsSync(directory))
    throw new Error(
      "health:all is composed by bun run health; no run report directory was provided",
    )
  process.exitCode = readReports(
    directory,
    checks.map((check) => check.id),
  ).some(needsAttention)
    ? 1
    : 0
} else {
  const check = checks.find((entry) => entry.id === id)
  if (!check) throw new Error(`Unknown health task: ${id}`)
  let value: HealthReport
  try {
    value = await check.run()
  } catch (error) {
    value = report(check.id, check.id, [
      {
        id: check.id,
        status: "unknown",
        message: safeError(error),
        remedy: "Restore access and rerun this check.",
      },
    ])
  }
  if (!value.items?.length)
    value = report(check.id, check.id, [
      { id: check.id, status: "unknown", message: "Check produced no observations." },
    ])
  if (directory) writeFileSync(join(directory, `${check.id}.json`), JSON.stringify(value))
  else process.stdout.write(renderHealth([value]))
  process.exitCode = needsAttention(value) ? 1 : 0
}
