import { Database } from "../../src/index.ts";
import { maybeGc, memoryDelta, sampleMemory } from "../harness/memory.ts";
import type { BenchSpec } from "../harness/types.ts";
import { spec } from "./tiers.ts";

export interface MemoryFootprint {
  rows: number;
  heapBytes: number;
  bytesPerRow: number;
  close(): void;
}

export function measureSmallRowFootprint(rows = 100_000): MemoryFootprint {
  maybeGc();
  const before = sampleMemory();
  const db = new Database();
  db.exec("CREATE TABLE memory_rows (n INTEGER, label TEXT)");
  const insert = db.prepare("INSERT INTO memory_rows(n, label) VALUES (?, ?)");
  db.transaction(() => {
    for (let i = 1; i <= rows; i++) insert.run(i % 1000, `r${i}`);
  });
  const count = db.query<{ count: number }>("SELECT COUNT(*) AS count FROM memory_rows")[0]?.count;
  if (count !== rows) throw new Error(`memory setup inserted ${count ?? 0} of ${rows} rows`);
  maybeGc();
  const heapBytes = Math.max(0, memoryDelta(before, sampleMemory()) ?? 0);
  return {
    rows,
    heapBytes,
    bytesPerRow: heapBytes / rows,
    close: () => db.close(),
  };
}

export function memoryFootprintSpecs(): BenchSpec[] {
  return [
    spec({
      name: "memory/small-rows/100000",
      operation: "retained heap for small rows",
      datasetSize: 100_000,
      tiers: ["full"],
      engines: "mem",
      warmup: 0,
      iterations: 1,
      setup: () => measureSmallRowFootprint(),
      fn: () => {},
      teardown: (_engine, ctx) => {
        (ctx as MemoryFootprint).close();
      },
      extra: (ctx) => {
        const measurement = ctx as MemoryFootprint;
        return { heapBytes: measurement.heapBytes, bytesPerRow: measurement.bytesPerRow };
      },
    }),
  ];
}
