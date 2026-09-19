import type { MemorySample } from "./types.ts";

interface ProcessLike {
  memoryUsage?: () => { heapUsed: number; heapTotal: number; rss: number };
}

interface PerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
}

export function maybeGc(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === "function") {
    gc();
    return;
  }
  const bun = (globalThis as { Bun?: { gc?: (sync: boolean) => void } }).Bun;
  bun?.gc?.(true);
}

export function sampleMemory(): MemorySample {
  const proc = (globalThis as { process?: ProcessLike }).process;
  if (proc?.memoryUsage) {
    const usage = proc.memoryUsage();
    return { heapUsed: usage.heapUsed, heapTotal: usage.heapTotal, rss: usage.rss };
  }
  const perf = performance as Performance & { memory?: PerformanceMemory };
  if (perf.memory) {
    return { heapUsed: perf.memory.usedJSHeapSize, heapTotal: perf.memory.totalJSHeapSize };
  }
  return {};
}

export function memoryDelta(before?: MemorySample, after?: MemorySample): number | undefined {
  if (before?.heapUsed === undefined || after?.heapUsed === undefined) return undefined;
  return after.heapUsed - before.heapUsed;
}
