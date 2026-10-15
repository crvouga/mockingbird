/** Turbo owns execution and dependency composition; the launcher owns a fresh run's reports. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { root } from "../release/lib.ts"
import { checks } from "./checks.ts"
import { safeError } from "./io.ts"
import { type HealthReport, needsAttention, renderHealth, report } from "./report.ts"

export function parseArgs(argv: string[], terminal = false) {
  const args = argv.filter((arg) => arg !== "--")
  const flags = new Set([
    "--help",
    "-h",
    "--json",
    "--verbose",
    "--interactive",
    "--no-interactive",
  ])
  if (args.includes("--interactive") && args.includes("--no-interactive"))
    throw new Error("Choose either --interactive or --no-interactive")
  const ids = args.filter((arg) => !arg.startsWith("-"))
  const unknown = args.filter((arg) =>
    arg.startsWith("-") ? !flags.has(arg) : !checks.some((check) => check.id === arg),
  )
  if (unknown.length) throw new Error(`Unknown health check or option: ${unknown.join(", ")}`)
  return {
    help: args.includes("--help") || args.includes("-h"),
    json: args.includes("--json"),
    verbose: args.includes("--verbose"),
    interactive:
      args.includes("--interactive") ||
      (terminal && !args.includes("--json") && !args.includes("--no-interactive")),
    selected: checks.filter((check) => ids.length === 0 || ids.includes(check.id)),
  }
}

export function readReports(directory: string, ids: string[]): HealthReport[] {
  return ids.map((id) => {
    try {
      const value = JSON.parse(readFileSync(join(directory, `${id}.json`), "utf8")) as HealthReport
      if (
        value.id !== id ||
        !Array.isArray(value.items) ||
        value.items.length === 0 ||
        value.items.some(
          (item) =>
            !item ||
            typeof item.id !== "string" ||
            typeof item.message !== "string" ||
            !["ok", "fail", "unknown", "pending", "optional"].includes(item.status),
        )
      )
        throw new Error("invalid report")
      return value
    } catch {
      return report(id, id, [
        {
          id: "task-report",
          status: "unknown",
          message: "Turbo task did not produce a valid report for this run.",
          remedy: `bun run health:${id}`,
        },
      ])
    }
  })
}

async function main() {
  const options = parseArgs(
    process.argv.slice(2),
    Boolean(
      process.stdin.isTTY &&
        process.stderr.isTTY &&
        !process.env.CI &&
        process.env.GITHUB_ACTIONS !== "true",
    ),
  )
  if (options.help) {
    console.log("bun run health [check…] [--json] [--verbose] [--interactive|--no-interactive]\n")
    for (const check of checks) console.log(`  ${check.id.padEnd(20)} ${check.summary}`)
    console.log(
      "\nRead-only live checks run through uncached Turbo tasks; failures do not stop other checks.\nTerminal runs request npm security-key approval when needed. JSON/CI runs do not prompt by default.\nUse --no-interactive to disable prompts, or --interactive to explicitly enable approval.\nExit 1 = failed, pending, or unknown required checks. Optional integrations are listed separately.",
    )
    return
  }
  const directory = mkdtempSync(join(tmpdir(), "mockingbird-health-"))
  try {
    const tasks =
      options.selected.length === checks.length
        ? ["health:all"]
        : options.selected.map((check) => `health:${check.id}`)
    const proc = Bun.spawn(
      [
        join(root, "node_modules/.bin/turbo"),
        "run",
        "--filter=//",
        ...tasks,
        "--continue=always",
        options.interactive ? "--output-logs=full" : "--output-logs=errors-only",
        "--log-order=stream",
        "--concurrency=4",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          MOCKINGBIRD_HEALTH_REPORT_DIR: directory,
          MOCKINGBIRD_HEALTH_INTERACTIVE: options.interactive ? "1" : "0",
          TURBO_UI: "stream",
        },
        stdin: "inherit",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    async function consume(stream: ReadableStream<Uint8Array>): Promise<string> {
      const chunks: Uint8Array[] = []
      for await (const chunk of stream) {
        chunks.push(chunk)
        // Approval links must be visible while the challenge is active.
        // Reserve stdout for the final report, including in JSON mode.
        if (options.interactive) process.stderr.write(chunk)
      }
      return Buffer.concat(chunks).toString("utf8")
    }
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      consume(proc.stdout),
      consume(proc.stderr),
    ])
    const reports = readReports(
      directory,
      options.selected.map((check) => check.id),
    )
    if (code !== 0 && !reports.some(needsAttention))
      reports.push(
        report("runner", "Turbo execution", [
          {
            id: "turbo",
            status: "unknown",
            message: `Turbo exited ${code}.`,
            remedy: "Inspect the Turbo task configuration.",
          },
        ]),
      )
    if (options.verbose && !options.json && !options.interactive)
      process.stderr.write(safeError(`${stdout}\n${stderr}`))
    const healthy = !reports.some(needsAttention)
    if (options.json)
      console.log(
        JSON.stringify(
          { schemaVersion: 1, checkedAt: new Date().toISOString(), healthy, reports },
          null,
          2,
        ),
      )
    else process.stdout.write(renderHealth(reports, options.verbose))
    process.exitCode = healthy ? 0 : 1
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

if (import.meta.main)
  main().catch((error) => {
    console.error(`health: ${safeError(error)}`)
    process.exitCode = 1
  })
