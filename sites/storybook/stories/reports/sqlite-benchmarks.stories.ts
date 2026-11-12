import type { Meta, StoryObj } from "@storybook/html-vite"
import type { BenchReport } from "../../../../packages/service/sqlite/benchmarks/harness/types.js"
import baseline from "../../../../packages/service/sqlite/benchmarks/results/ci-baseline.json" with {
  type: "json",
}
import throttle from "../../../../packages/service/sqlite/benchmarks/results/throttle-baseline.json" with {
  type: "json",
}
import { markup } from "../../src/story.js"

/**
 * The renderer, loaded by Vite rather than `import`ed: the harness imports its siblings as
 * `./report.ts`, which the catalog's TypeScript settings refuse to follow.
 */
const harness = Object.values(
  import.meta.glob<{ renderHtmlReport(report: BenchReport): string }>(
    "../../../../packages/service/sqlite/benchmarks/harness/html-report.ts",
    { eager: true },
  ),
)[0]
const renderHtmlReport = (report: BenchReport): string => {
  if (!harness) throw new Error("the benchmark harness's html-report.ts is missing")
  return harness.renderHtmlReport(report)
}

/**
 * The sqlite-mem benchmark report (`bun run benchmarks/report-html.ts`), drawn from the committed
 * CI baseline: sections by workload (parser, hotspots, full-text search among them), latencies
 * ranked within each, and a browser run's device profile and CPU throttle in the header.
 */
export default {
  title: "Reports/sqlite-mem benchmarks",
  parameters: {
    layout: "fullscreen",
    sources: ["packages/service/sqlite/benchmarks/harness/html-report.ts"],
  },
} satisfies Meta

const CI = baseline as BenchReport

/** The committed CI baseline. */
export const CiBaseline: StoryObj = markup(() => renderHtmlReport(CI))

/** A run in throttled Chromium (`benchmarks/results/throttle-baseline.json`'s profile). */
export const BrowserRun: StoryObj = markup(() =>
  renderHtmlReport({
    ...CI,
    environment: {
      runtime: "browser",
      runtimeVersion: "Chrome/140.0.0.0",
      platform: "linux",
      browser: "Chromium 140",
      deviceProfile: throttle.platform,
      cpuThrottle: throttle.cpuThrottle,
    },
  }),
)

/**
 * A `--engines compare-sqlite` run: sqlite-mem next to bun:sqlite. The bun:sqlite rows are the
 * baseline's timings scaled, for the layout only.
 */
export const ComparedWithSqlite: StoryObj = markup(() =>
  renderHtmlReport({
    ...CI,
    tier: "default",
    results: CI.results.flatMap((result) => [
      result,
      {
        ...result,
        engine: "bun:sqlite",
        p50: result.p50 / 4,
        p95: result.p95 / 3.5,
        p99: result.p99 / 3,
        mean: result.mean / 4,
        perOpMs: result.perOpMs / 4,
        opsPerSec: result.opsPerSec * 4,
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
