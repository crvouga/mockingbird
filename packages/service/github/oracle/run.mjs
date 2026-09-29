import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { resolve, sep } from "node:path"
import { ghCredential } from "./auth.mjs"
import { executeOracle } from "./execute.mjs"
import { digest, preparePlan, validateExecution, validateScope } from "./plan.mjs"

const args = new Map()
for (const arg of process.argv.slice(2)) {
  const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg)
  if (!match || args.has(match[1])) throw new Error("Use unique named --key=value options")
  args.set(match[1], match[2] ?? true)
}
const allowed = [
  "plan",
  "execute",
  "repository",
  "run-id",
  "api-version",
  "operations",
  "confirm",
  "allow-writes",
  "allow-notifications",
  "allow-cleanup",
  "gh-auth",
]
if (
  [...args.keys()].some((key) => !allowed.includes(key)) ||
  args.has("plan") === args.has("execute")
)
  throw new Error("Select exactly --plan or --execute with documented options")
const runId = args.get("run-id")
if (
  typeof runId !== "string" ||
  !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(runId)
)
  throw new Error("Explicit UUIDv4 --run-id required")
const root = await realpath(resolve(import.meta.dirname, "../../../.."))
const directory = resolve(root, ".mockingbird/github-oracle", runId)
await mkdir(directory, { recursive: true })
if (!(await realpath(directory)).startsWith(root + sep))
  throw new Error("Oracle files must stay inside this project")
const planPath = resolve(directory, "plan.json")
if (args.has("plan")) {
  const plan = preparePlan({
    repository: args.get("repository"),
    runId,
    apiVersion: args.get("api-version"),
    comparedOperations:
      typeof args.get("operations") === "string" ? args.get("operations").split(",") : undefined,
  })
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" })
  console.log(JSON.stringify({ plan, digest: digest(plan), path: planPath }, null, 2))
} else {
  const plan = JSON.parse(await readFile(planPath, "utf8"))
  const grants = {
    confirmedDigest: args.get("confirm"),
    writes: args.get("allow-writes") === true,
    notifications: args.get("allow-notifications") === true,
    cleanup: args.get("allow-cleanup") === true,
    token: process.env.MOCKINGBIRD_GITHUB_TOKEN,
  }
  validateScope(plan, grants)
  if (args.get("gh-auth") === true) grants.token = await ghCredential()
  validateExecution(plan, grants)
  const reportPath = resolve(directory, "report.json")
  // A prior/partial execution must be inspected, never implicitly retried or overwritten.
  await writeFile(reportPath, "{}\n", { flag: "wx" })
  const { GitHubAPI } = await import("../dist/index.js")
  const report = await executeOracle(plan, grants, {
    mock: new GitHubAPI(),
    save: (report) => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`),
  })
  console.log(
    JSON.stringify(
      {
        complete: report.complete,
        reportPath,
        comparisons: report.comparisons,
        cleanup: report.cleanup,
        failures: report.failures,
      },
      null,
      2,
    ),
  )
  if (!report.complete) process.exitCode = 1
}
