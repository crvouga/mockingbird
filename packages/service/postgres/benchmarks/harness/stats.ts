export interface TimingStats {
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  min: number;
  max: number;
  opsPerSec: number;
  perOpMs: number;
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loVal = sorted[lo] ?? 0;
  const hiVal = sorted[hi] ?? loVal;
  if (lo === hi) return loVal;
  return loVal + (hiVal - loVal) * (idx - lo);
}

export function summarize(samplesMs: readonly number[], opsPerSample: number): TimingStats {
  if (samplesMs.length === 0) {
    return { p50: 0, p95: 0, p99: 0, mean: 0, min: 0, max: 0, opsPerSec: 0, perOpMs: 0 };
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const sum = samplesMs.reduce((acc, value) => acc + value, 0);
  const mean = sum / samplesMs.length;
  const totalOps = samplesMs.length * opsPerSample;
  const opsPerSec = sum > 0 ? (totalOps / sum) * 1000 : 0;
  const ops = Math.max(1, opsPerSample);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    mean,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    opsPerSec,
    perOpMs: mean / ops,
  };
}

export function nowMs(): number {
  return performance.now();
}
