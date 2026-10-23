import type { Fixture, Result, Workload } from "./types.ts"

export function percentile(sorted: number[], fraction: number): number {
  const value = sorted[Math.ceil(sorted.length * fraction) - 1]
  if (value === undefined) throw new Error("Performance test produced no samples")
  return value
}

export async function measure(
  workload: Workload,
  warmup: number,
  samples: number,
): Promise<Result> {
  const times: number[] = []
  let fixture: Fixture | undefined
  let details: Record<string, number> = {}
  try {
    if (!workload.isolate) fixture = await workload.setup()
    for (let iteration = 0; iteration < warmup + samples; iteration++) {
      const current = workload.isolate ? await workload.setup() : fixture
      if (!current) throw new Error("Missing performance fixture")
      try {
        const start = performance.now()
        await current.run()
        const elapsed = performance.now() - start
        if (iteration >= warmup) times.push(elapsed)
        if (workload.isolate) await current.verify()
      } finally {
        if (workload.isolate) await current.close()
      }
    }
    if (fixture) {
      await fixture.verify()
      details = fixture.details?.() ?? {}
    }
  } finally {
    await fixture?.close()
  }
  if (workload.probe) details = { ...details, ...(await workload.probe()) }
  times.sort((a, b) => a - b)
  const medianMs = percentile(times, 0.5)
  return {
    name: workload.name,
    operations: workload.operations,
    samples,
    medianMs,
    p95Ms: percentile(times, 0.95),
    perOperationUs: (medianMs * 1000) / workload.operations,
    details,
  }
}

export async function profile(workload: Workload, durationMs: number): Promise<void> {
  const fixture = workload.isolate ? undefined : await workload.setup()
  const once = async () => {
    const current = fixture ?? (await workload.setup())
    try {
      await current.run()
      if (workload.isolate) await current.verify()
    } finally {
      if (workload.isolate) await current.close()
    }
  }
  try {
    for (let i = 0; i < 3; i++) await once()
    const end = performance.now() + durationMs
    let iterations = 0
    while (performance.now() < end) {
      await once()
      iterations++
    }
    await fixture?.verify()
    console.log(`${workload.name}: ${iterations} validated iterations during CPU profiling`)
  } finally {
    await fixture?.close()
  }
}
