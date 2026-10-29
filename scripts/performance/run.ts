import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import budgets from "./budgets.json" with { type: "json" }
import { bufferedWorkloads } from "./buffered.ts"
import { engines } from "./engines.ts"
import { checkReport, compareReports } from "./gate.ts"
import { measure, profile } from "./harness.ts"
import { productionWorkloads } from "./production.ts"
import type { Report } from "./types.ts"
import { workloads } from "./workloads.ts"

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

const checking = process.argv.includes("--check")
const samples = Number(argument("--samples") ?? 9)
const timingAttempts = 3
if (!Number.isInteger(samples) || samples < (checking ? 5 : 1))
  throw new Error("Expected at least five samples for a performance gate")
const only = argument("--only")
const production = process.argv.includes("--production")
const buffered = process.argv.includes("--buffered")
if (buffered && production) throw new Error("Select either --buffered or --production")
const rows = Number(argument("--rows") ?? 100_000)
if (!Number.isSafeInteger(rows) || rows < 1000) throw new Error("Expected --rows >= 1000")
const loaded = await engines(
  !buffered && !process.argv.includes("--no-wasm"),
  argument("--modules"),
)
const selected = (
  buffered
    ? bufferedWorkloads(loaded, rows, process.argv.includes("--canary-buffered-snapshot"))
    : (production ? productionWorkloads : workloads)(loaded, process.argv.includes("--canary-scan"))
).filter((workload) => !only || workload.name.includes(only))
if (selected.length === 0) throw new Error(`No performance workloads matched ${only}`)

if (process.argv.includes("--profile-worker")) {
  const first = selected[0]
  if (!first || selected.length !== 1) throw new Error("Select exactly one workload for profiling")
  await profile(first, 3000)
} else {
  const report: Report = {
    schema: 1,
    environment: { platform: process.platform, arch: process.arch, bun: Bun.version },
    warmup: 3,
    results: [],
    failures: [],
  }
  for (const workload of selected) {
    try {
      const result = await measure(workload, report.warmup, samples)
      report.results.push(result)
      console.log(
        `${result.name.padEnd(48)} median ${result.medianMs.toFixed(3).padStart(9)} ms  p95 ${result.p95Ms.toFixed(3).padStart(9)} ms  ${result.perOperationUs.toFixed(2)} us/op`,
      )
    } catch (error) {
      report.failures.push(`${workload.name}: ${String(error)}`)
    }
  }
  if (report.results.length !== selected.length)
    report.failures.push("Incomplete performance report")
  if (checking) {
    const gate = () =>
      checkReport(
        report,
        only
          ? selected.map((workload) => workload.name)
          : Object.keys(budgets.maxMedianMs).filter(
              (name) =>
                name.includes("/production/") === production &&
                name.includes("/buffered/") === buffered &&
                (!buffered || name.endsWith(`/${rows}`)) &&
                (!process.argv.includes("--no-wasm") || !name.startsWith("sql.js/")),
            ),
        budgets.maxMedianMs,
        budgets.maxWork,
        budgets.wasmRatios,
      )
    // A shared CI runner can stall a whole workload; noise only ever slows a measurement down, so
    // a workload that misses a timing limit is re-measured and its best median is the one judged.
    // A real regression is slow on every attempt and still fails.
    const timing = /^(.+?): (?:median [\d.]+ ms exceeds|exceeds [\d.]+x )/
    for (let attempt = 1; attempt < timingAttempts; attempt++) {
      const failures = gate()
      // A workload that also breaks a deterministic limit is a real regression; re-measuring it
      // only burns time.
      const broken = new Set(
        failures.flatMap((failure) => (timing.test(failure) ? [] : [failure.split(": ")[0]])),
      )
      const slow = new Set(
        failures
          .flatMap((failure) => timing.exec(failure)?.[1] ?? [])
          .filter((name) => !broken.has(name)),
      )
      if (slow.size === 0) break
      for (const workload of selected.filter((candidate) => slow.has(candidate.name))) {
        const index = report.results.findIndex((result) => result.name === workload.name)
        const first = report.results[index]
        if (!first) continue
        try {
          const retry = await measure(workload, report.warmup, samples)
          console.log(
            `${`${retry.name} (retry ${attempt})`.padEnd(48)} median ${retry.medianMs.toFixed(3).padStart(9)} ms  p95 ${retry.p95Ms.toFixed(3).padStart(9)} ms`,
          )
          if (retry.medianMs < first.medianMs) report.results[index] = retry
        } catch (error) {
          report.failures.push(`${workload.name}: ${String(error)}`)
        }
      }
    }
    report.failures.push(...gate())
  }
  const baselinePath = argument("--baseline")
  if (baselinePath) {
    const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as Report
    report.failures.push(
      ...compareReports(
        report,
        baseline,
        only ? selected.map((workload) => workload.name) : undefined,
      ),
    )
  }
  console.log("\nLargest measured costs per operation:")
  for (const result of [...report.results]
    .sort((a, b) => b.perOperationUs - a.perOperationUs)
    .slice(0, 8)) {
    console.log(
      `  ${result.name}: ${result.perOperationUs.toFixed(2)} us/op ${JSON.stringify(result.details)}`,
    )
  }
  const out = resolve(argument("--out") ?? ".performance/latest.json")
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`\nSaved ${out}`)
  for (const failure of report.failures) console.error(failure)
  if (report.failures.length > 0) process.exitCode = 1
}
