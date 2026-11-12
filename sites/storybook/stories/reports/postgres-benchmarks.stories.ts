import type { Meta, StoryObj } from "@storybook/html-vite"
import type { BenchReport } from "../../../../packages/service/postgres/benchmarks/harness/types.js"
import baseline from "../../../../packages/service/postgres/benchmarks/results/ci-baseline.json" with {
  type: "json",
}
import { markup } from "../../src/story.js"

/**
 * The renderer, loaded by Vite rather than `import`ed: the harness imports its siblings as
 * `./report.ts`, which the catalog's TypeScript settings refuse to follow.
 */
const harness = Object.values(
  import.meta.glob<{ renderHtmlReport(report: BenchReport): string }>(
    "../../../../packages/service/postgres/benchmarks/harness/html-report.ts",
    { eager: true },
  ),
)[0]
const renderHtmlReport = (report: BenchReport): string => {
  if (!harness) throw new Error("the benchmark harness's html-report.ts is missing")
  return harness.renderHtmlReport(report)
}

/**
 * The postgres-mem benchmark report (`bun run benchmarks/run.ts --html`), drawn from the committed
 * CI baseline: sections by workload, latencies ranked hot to cold within each, the slowest and
 * fastest five, and percentiles marked unreliable when a bench ran fewer than five samples.
 */
export default {
  title: "Reports/postgres-mem benchmarks",
  parameters: {
    layout: "fullscreen",
    sources: ["packages/service/postgres/benchmarks/harness/html-report.ts"],
  },
} satisfies Meta

const CI = baseline as BenchReport

/** The committed CI baseline. */
export const CiBaseline: StoryObj = markup(() => renderHtmlReport(CI))

/**
 * A `--engines both` run: every bench on postgres-mem and on PGlite. The PGlite rows are the
 * baseline's timings scaled, for the layout only.
 */
export const BothEngines: StoryObj = markup(() =>
  renderHtmlReport({
    ...CI,
    tier: "default",
    results: CI.results.flatMap((result) => [
      result,
      {
        ...result,
        engine: "pglite",
        p50: result.p50 * 3.2,
        p95: result.p95 * 2.8,
        p99: result.p99 * 2.6,
        mean: result.mean * 3,
        perOpMs: result.perOpMs * 3,
        opsPerSec: result.opsPerSec / 3,
      },
    ]),
  }),
)

/** A run that measured nothing. */
export const NoResults: StoryObj = markup(() => renderHtmlReport({ ...CI, results: [] }))

export const OnAPhone: StoryObj = {
  ...CiBaseline,
  globals: { viewport: { value: "phone", isRotated: false } },
}
