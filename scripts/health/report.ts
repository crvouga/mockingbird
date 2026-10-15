/**
 * A health check reports only what a person still has to fix.
 * Add a check by appending it to `checks` in ./checks.ts.
 */

/** One place that needs a fix. `url` is the page to open; otherwise `id` is the line to print. */
export type HealthFinding = {
  id: string
  url?: string
}

/** Findings that share one instruction. The instruction is printed once, then the links. */
export type HealthGroup = {
  summary: string
  findings: HealthFinding[]
}

export type HealthReport = {
  id: string
  title: string
  groups: HealthGroup[]
  /** The check could not run. No per-package list is meaningful until this is resolved. */
  error?: string
  items?: HealthItem[]
}

export type HealthStatus = "ok" | "fail" | "unknown" | "pending" | "optional"
export type HealthItem = {
  id: string
  status: HealthStatus
  message: string
  url?: string
  remedy?: string
}

export function report(id: string, title: string, items: HealthItem[]): HealthReport {
  return { id, title, groups: [], items }
}

export function unhealthy(item: HealthItem): boolean {
  return item.status !== "ok" && item.status !== "optional"
}

export type HealthCheck = {
  id: string
  /** One line for `bun run health -- --help`. */
  summary: string
  run: () => Promise<HealthReport>
}

export function findingCount(report: HealthReport): number {
  return report.groups.reduce((count, group) => count + group.findings.length, 0)
}

export function needsAttention(report: HealthReport): boolean {
  if (report.items) return report.items.length === 0 || report.items.some(unhealthy)
  return report.error !== undefined || findingCount(report) > 0
}

export function renderHealth(reports: HealthReport[], verbose = false): string {
  const lines = ["health", ""]
  for (const report of reports) {
    if (report.items) {
      const items = report.items
      const counts = Object.fromEntries(
        (["ok", "fail", "unknown", "pending", "optional"] as const).map((status) => [
          status,
          items.filter((item) => item.status === status).length,
        ]),
      )
      lines.push(
        `${report.title} — ${
          Object.entries(counts)
            .filter(([, n]) => n)
            .map(([s, n]) => `${n} ${s}`)
            .join(", ") || "not checked"
        }`,
      )
      for (const item of items) {
        if (!verbose && (item.status === "ok" || item.status === "optional")) continue
        lines.push(`  [${item.status.toUpperCase()}] ${item.id}: ${item.message}`)
        if (item.remedy) lines.push(`    Fix: ${item.remedy}`)
        if (item.url) lines.push(`    ${item.url}`)
      }
      if (!verbose && items.some((item) => item.status === "optional"))
        lines.push(
          "  --verbose lists optional integrations and missing on-demand/local credentials.",
        )
      lines.push("")
      continue
    }
    if (report.error) {
      lines.push(`${report.title} — could not check`, report.error, "")
      continue
    }
    const count = findingCount(report)
    if (count === 0) {
      lines.push(`${report.title} — ok`, "")
      continue
    }
    lines.push(`${report.title} — ${count} to fix`, "")
    for (const group of report.groups) {
      if (group.findings.length === 0) continue
      lines.push(group.summary)
      for (const finding of group.findings) lines.push(finding.url ?? finding.id)
      lines.push("")
    }
  }
  if (reports.some((value) => value.items !== undefined)) {
    lines.push(
      reports.some(needsAttention)
        ? "ATTENTION — failures, pending work, or checks that could not run."
        : "HEALTHY — all required checks passed.",
      "",
    )
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`
}
