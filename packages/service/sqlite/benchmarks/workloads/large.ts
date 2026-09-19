import type { BenchSpec } from "../harness/types.ts";
import { fillUsers } from "./populate.ts";
import { spec } from "./tiers.ts";

export function largeSpecs(): BenchSpec[] {
  return [
    spec({
      name: "large/full-scan/10000",
      operation: "full scan",
      datasetSize: 10_000,
      tiers: ["default", "full"],
      warmup: 1,
      iterations: 6,
      setup: (engine) => {
        fillUsers(engine, 10_000);
        return engine.prepare("SELECT COUNT(*) AS c FROM users WHERE name LIKE 'User%'");
      },
      fn: (_engine, ctx) => {
        (ctx as { get: () => unknown }).get();
      },
    }),
    spec({
      name: "large/indexed-vs-scan/10000",
      operation: "indexed equality",
      datasetSize: 10_000,
      tiers: ["default", "full"],
      warmup: 1,
      iterations: 10,
      opsPerSample: 20,
      setup: (engine) => {
        fillUsers(engine, 10_000, true);
        return engine.prepare("SELECT id FROM users WHERE email = ?");
      },
      fn: (_engine, ctx) => {
        const stmt = ctx as { get: (v: string) => unknown };
        for (let i = 0; i < 20; i++) stmt.get(`u${100 + i * 10}@ex.test`);
      },
    }),
    spec({
      name: "large/full-scan/100000",
      operation: "full scan",
      datasetSize: 100_000,
      tiers: ["full"],
      warmup: 0,
      iterations: 3,
      setup: (engine) => {
        fillUsers(engine, 100_000);
        return engine.prepare("SELECT COUNT(*) AS c FROM users");
      },
      fn: (_engine, ctx) => {
        (ctx as { get: () => unknown }).get();
      },
    }),
    spec({
      name: "large/pk-lookup/100000",
      operation: "pk lookup",
      datasetSize: 100_000,
      tiers: ["full"],
      warmup: 0,
      iterations: 8,
      opsPerSample: 20,
      setup: (engine) => {
        fillUsers(engine, 100_000);
        return engine.prepare("SELECT id, name FROM users WHERE id = ?");
      },
      fn: (_engine, ctx) => {
        const stmt = ctx as { get: (id: number) => unknown };
        for (let i = 0; i < 20; i++) stmt.get(50_000 + i);
      },
    }),
    spec({
      name: "large/pk-lookup/1000000",
      operation: "pk lookup",
      datasetSize: 1_000_000,
      tiers: ["full"],
      warmup: 0,
      iterations: 1,
      setup: (engine) => {
        fillUsers(engine, 1_000_000);
        return engine.prepare("SELECT id, name FROM users WHERE id = ?");
      },
      fn: (_engine, ctx) => {
        (ctx as { get: (id: number) => unknown }).get(500_000);
      },
    }),
  ];
}
