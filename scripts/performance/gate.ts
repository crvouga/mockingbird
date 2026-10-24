import type { Report, Result } from "./types.ts"

/** Fail closed on missing/invalid measurements and on deterministic work-count regressions. */
export function checkReport(
  report: Report,
  expected: readonly string[],
  budgets: Readonly<Record<string, number>>,
  workLimits: Readonly<Record<string, Readonly<Record<string, number>>>> = {},
  references: Readonly<Record<string, { reference: string; factor: number; floorMs: number }>> = {},
): string[] {
  const failures: string[] = []
  const seen = new Set<string>()
  for (const result of report.results) {
    if (seen.has(result.name)) failures.push(`Duplicate workload: ${result.name}`)
    seen.add(result.name)
    if (!expected.includes(result.name)) failures.push(`Unexpected workload: ${result.name}`)
    if (
      result.samples < 5 ||
      !Number.isInteger(result.samples) ||
      !Number.isFinite(result.medianMs) ||
      result.medianMs < 0 ||
      !Number.isFinite(result.p95Ms) ||
      result.p95Ms < result.medianMs ||
      result.operations < 1 ||
      !Number.isInteger(result.operations)
    ) {
      failures.push(`Invalid performance measurement: ${result.name}`)
    }
    const ceiling = budgets[result.name]
    if (ceiling === undefined || !Number.isFinite(ceiling) || ceiling <= 0)
      failures.push(`Missing/invalid budget: ${result.name}`)
    else if (result.medianMs > ceiling)
      failures.push(`${result.name}: median ${result.medianMs.toFixed(2)} ms exceeds ${ceiling} ms`)
    for (const [count, maximum] of Object.entries(workLimits[result.name] ?? {})) {
      const visits = result.details[count]
      if (visits === undefined || !Number.isFinite(visits) || visits < 0 || visits > maximum) {
        failures.push(`${result.name}: ${count} ${visits} exceeds ${maximum}`)
      }
    }
  }
  for (const name of expected) if (!seen.has(name)) failures.push(`Missing workload: ${name}`)
  for (const [name, limit] of Object.entries(references)) {
    if (!expected.includes(name) || !expected.includes(limit.reference)) continue
    const result = report.results.find((candidate) => candidate.name === name)
    const reference = report.results.find((candidate) => candidate.name === limit.reference)
    if (!result || !reference) {
      failures.push(`Missing WASM comparison: ${name}`)
      continue
    }
    if (result.medianMs > Math.max(limit.floorMs, reference.medianMs * limit.factor)) {
      failures.push(
        `${name}: exceeds ${limit.factor}x ${limit.reference} (floor ${limit.floorMs} ms)`,
      )
    }
  }
  return failures
}

/** Compare like-for-like reports; do not silently skip platform mismatches or missing cases. */
export function compareReports(
  current: Report,
  baseline: Report,
  selected?: readonly string[],
): string[] {
  const failures: string[] = []
  if (
    baseline.failures.length > 0 ||
    new Set(baseline.results.map((result) => result.name)).size !== baseline.results.length
  )
    return ["Invalid or failed performance baseline"]
  if (
    baseline.schema !== current.schema ||
    baseline.warmup !== current.warmup ||
    baseline.environment.platform !== current.environment.platform ||
    baseline.environment.arch !== current.environment.arch ||
    baseline.environment.bun !== current.environment.bun
  )
    return ["Performance baseline runtime/platform/architecture/schema mismatch"]
  const byName = new Map<string, Result>(current.results.map((result) => [result.name, result]))
  for (const before of baseline.results) {
    if (selected && !selected.includes(before.name)) continue
    const after = byName.get(before.name)
    if (!after) {
      failures.push(`Missing baseline workload: ${before.name}`)
      continue
    }
    if (
      before.operations !== after.operations ||
      before.samples < 5 ||
      !Number.isFinite(before.medianMs) ||
      before.medianMs < 0
    ) {
      failures.push(`Incompatible baseline workload: ${before.name}`)
    } else if (after.medianMs > Math.max(before.medianMs * 1.75, before.medianMs + 5)) {
      failures.push(
        `${before.name}: median regressed from ${before.medianMs.toFixed(2)} to ${after.medianMs.toFixed(2)} ms`,
      )
    }
  }
  for (const result of current.results) {
    if (!baseline.results.some((before) => before.name === result.name))
      failures.push(`Workload missing from baseline: ${result.name}`)
  }
  return failures
}
