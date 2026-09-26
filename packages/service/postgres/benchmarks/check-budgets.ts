import path from "node:path";
import budgets from "./budgets.json";
import type { BenchReport, BenchResult } from "./harness/types.ts";
import { RELIABLE_PERCENTILE_MIN_SAMPLES } from "./harness/types.ts";
import { measureSmallRowFootprint } from "./workloads/memory-footprint.ts";

const failures: string[] = [];

/** `ciMedianMs` is calibrated against GHA ubuntu. Darwin `check:full` already self-gates compare-ci. */
const TIMING_BUDGET_PLATFORM = "linux";

function timingCeilingMs(budget: number, result: BenchResult): number {
  const unreliable = result.reliablePercentiles === false || result.iterations < RELIABLE_PERCENTILE_MIN_SAMPLES;
  // n<5: p50 is one sample; JSON is ~3× a quiet linux median. Need an absolute floor
  // so insert/snapshot roundtrip cannot flake on a noisy GHA runner.
  if (unreliable) return Math.max(budget * 2, 50);
  // n≥5: 25% on top of the ~3× JSON ceiling, 10ms floor so 1.01ms benches don't flap.
  return Math.max(budget * 1.25, 10);
}

// 1. Memory footprint budget (measured directly, like sqlite-mem).
const memBudget = budgets.smallRows100k;
const measurement = measureSmallRowFootprint(memBudget.rows);
try {
  console.log(
    `Memory footprint (${measurement.rows} rows): ${measurement.heapBytes.toLocaleString()} heap bytes, ${measurement.bytesPerRow.toFixed(1)} bytes/row`,
  );
  if (measurement.heapBytes > memBudget.maxHeapBytes) {
    failures.push(`heap ${measurement.heapBytes} > budget ${memBudget.maxHeapBytes}`);
  }
  if (measurement.bytesPerRow > memBudget.maxBytesPerRow) {
    failures.push(`bytes/row ${measurement.bytesPerRow.toFixed(1)} > budget ${memBudget.maxBytesPerRow}`);
  }
} finally {
  measurement.close();
}

// 2. Timing budgets: linux CI only. compare-ci.ts is the same-platform ratio gate.
const latestPath = process.argv[2] ?? path.join(import.meta.dir, "results/ci-latest.json");
const latestFile = Bun.file(latestPath);
if (await latestFile.exists()) {
  const report = (await latestFile.json()) as BenchReport;
  const platform = report.environment?.platform;
  if (platform && platform !== TIMING_BUDGET_PLATFORM) {
    console.warn(
      `Timing budgets skipped: platform=${platform} (ceilings are for ${TIMING_BUDGET_PLATFORM} CI; compare-ci already self-gated)`,
    );
  } else {
    const byName = new Map(report.results.filter((r) => r.engine === "postgres-mem").map((r) => [r.name, r] as const));
    const budgeted = Object.entries(budgets.ciMedianMs as Record<string, number>);
    let checked = 0;
    for (const [name, budget] of budgeted) {
      const result = byName.get(name);
      if (!result) continue;
      checked++;
      const median = result.p50 || result.mean;
      const ceiling = timingCeilingMs(budget, result);
      if (median > ceiling) {
        failures.push(`${name}: median ${median.toFixed(3)}ms > budget ${ceiling.toFixed(2)}ms`);
      }
    }
    console.log(`Timing budgets: ${checked}/${budgeted.length} benchmarks checked against ${latestPath}`);
  }
} else {
  console.warn(`Timing budgets skipped: ${latestPath} not found (run \`bun run benchmark:ci\` to produce it)`);
}

if (failures.length > 0) {
  console.error("Budget exceeded:");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
} else {
  console.log("All budgets OK");
}
