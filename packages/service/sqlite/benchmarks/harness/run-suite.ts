import { sampleMemory } from "./memory.ts";
import { detectEnvironment, formatReport } from "./report.ts";
import { nowMs, summarize } from "./stats.ts";
import type {
  BenchEngine,
  BenchReport,
  BenchResult,
  BenchSpec,
  EngineFactory,
  EnvironmentInfo,
  NamedFactory,
  SuiteTier,
} from "./types.ts";
import { RELIABLE_PERCENTILE_MIN_SAMPLES } from "./types.ts";

export type { NamedFactory };

const COMPARE_JS = new Set(["sqlite-mem", "alasql"]);
const COMPARE_SQLITE = new Set(["sqlite-mem", "bun-sqlite", "sql.js", "wa-sqlite"]);
const COMPARE_ALL = new Set([...COMPARE_JS, ...COMPARE_SQLITE]);

export function engineAllowed(spec: BenchSpec, engineName: string): boolean {
  const kind = spec.engines ?? "both";
  if (kind === "both") return engineName === "sqlite-mem" || engineName === "bun-sqlite";
  if (kind === "mem") return engineName === "sqlite-mem";
  if (kind === "sqlite") return engineName === "bun-sqlite";
  if (kind === "alasql") return engineName === "alasql";
  if (kind === "sqljs") return engineName === "sql.js";
  if (kind === "wa-sqlite") return engineName === "wa-sqlite";
  if (kind === "compare-js") return COMPARE_JS.has(engineName);
  if (kind === "compare-sqlite") return COMPARE_SQLITE.has(engineName);
  if (kind === "compare") return COMPARE_ALL.has(engineName);
  return true;
}

export function specsForTier(specs: readonly BenchSpec[], tier: SuiteTier): BenchSpec[] {
  return specs.filter((spec) => spec.tiers.includes(tier));
}

function countsForTier(spec: BenchSpec, tier: SuiteTier): { warmup: number; iterations: number } {
  if (tier === "ci") return { warmup: Math.min(spec.warmup, 2), iterations: Math.min(spec.iterations, 20) };
  if (tier === "default") return { warmup: Math.min(spec.warmup, 3), iterations: Math.min(spec.iterations, 12) };
  return { warmup: spec.warmup, iterations: spec.iterations };
}

async function runTimedSample(spec: BenchSpec, engine: BenchEngine, ctx: unknown): Promise<number> {
  const start = nowMs();
  await spec.fn(engine, ctx);
  return nowMs() - start;
}

export async function runSpec(spec: BenchSpec, factory: EngineFactory, tier: SuiteTier = "full"): Promise<BenchResult> {
  const { warmup, iterations } = countsForTier(spec, tier);
  const opsPerSample = spec.opsPerSample ?? 1;
  const samples: number[] = [];
  let memoryBefore = sampleMemory();
  let memoryAfter = sampleMemory();
  let extraCtx: unknown;
  let engineName = "unknown";

  if (spec.isolateIterations) {
    for (let i = 0; i < warmup; i++) {
      const engine = await factory();
      engineName = engine.name;
      try {
        const ctx = await spec.setup?.(engine);
        await spec.fn(engine, ctx);
        await spec.teardown?.(engine, ctx);
      } finally {
        await engine.close();
      }
    }
    memoryBefore = sampleMemory();
    for (let i = 0; i < iterations; i++) {
      const engine = await factory();
      engineName = engine.name;
      try {
        const ctx = await spec.setup?.(engine);
        samples.push(await runTimedSample(spec, engine, ctx));
        if (i === iterations - 1) {
          extraCtx = ctx;
          memoryAfter = sampleMemory();
        }
        await spec.teardown?.(engine, ctx);
      } finally {
        await engine.close();
      }
    }
  } else {
    const engine = await factory();
    engineName = engine.name;
    try {
      const ctx = await spec.setup?.(engine);
      extraCtx = ctx;
      for (let i = 0; i < warmup; i++) await spec.fn(engine, ctx);
      memoryBefore = sampleMemory();
      for (let i = 0; i < iterations; i++) {
        samples.push(await runTimedSample(spec, engine, ctx));
      }
      memoryAfter = sampleMemory();
      await spec.teardown?.(engine, ctx);
    } finally {
      await engine.close();
    }
  }

  const stats = summarize(samples, opsPerSample);
  const extra = spec.extra?.(extraCtx);
  if (extra && typeof extra.snapshotBytes === "number" && stats.mean > 0) {
    extra.mbPerSec = extra.snapshotBytes / 1e6 / (stats.mean / 1000);
  }
  return {
    name: spec.name,
    datasetSize: spec.datasetSize ?? null,
    operation: spec.operation,
    engine: engineName,
    iterations,
    warmup,
    opsPerSample,
    ...stats,
    reliablePercentiles: iterations >= RELIABLE_PERCENTILE_MIN_SAMPLES,
    layer: spec.layer,
    memoryBefore,
    memoryAfter,
    extra,
  };
}

export interface RunSuiteOptions {
  factories: NamedFactory[];
  specs: readonly BenchSpec[];
  tier: SuiteTier;
  environment?: Partial<EnvironmentInfo>;
  onResult?: (result: BenchResult) => void;
}

export async function runSuite(options: RunSuiteOptions): Promise<BenchReport> {
  const selected = specsForTier(options.specs, options.tier);
  const results: BenchResult[] = [];
  for (const spec of selected) {
    for (const factory of options.factories) {
      if (!engineAllowed(spec, factory.name)) continue;
      try {
        const result = await runSpec(spec, factory.create, options.tier);
        results.push(result);
        options.onResult?.(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`skip ${spec.name} [${factory.name}]: ${message}`);
      }
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    tier: options.tier,
    environment: detectEnvironment(options.environment),
    results,
  };
}

export function printReport(report: BenchReport): void {
  console.log(formatReport(report));
}
