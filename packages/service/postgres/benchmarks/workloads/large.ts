import type { BenchSpec, BenchStatement } from "../harness/types.ts";
import { fillUsers } from "./populate.ts";
import { spec } from "./tiers.ts";

export function largeSpecs(): BenchSpec[] {
  return [
    spec({
      name: "large/bulk-insert/10000",
      operation: "10k-row bulk insert in transaction",
      datasetSize: 10_000,
      tiers: ["default", "full"],
      layer: "engine",
      isolateIterations: true,
      warmup: 0,
      iterations: 2,
      opsPerSample: 10_000,
      setup: async (engine) => {
        await engine.exec(`CREATE TABLE bulk (
          id int PRIMARY KEY,
          email text NOT NULL,
          name text NOT NULL,
          created_at int NOT NULL
        )`);
        return engine.prepare("INSERT INTO bulk(id, email, name, created_at) VALUES ($1, $2, $3, $4)");
      },
      fn: async (engine, ctx) => {
        const stmt = ctx as BenchStatement;
        await engine.transaction(async () => {
          for (let i = 1; i <= 10_000; i++) {
            await stmt.run(i, `u${i}@ex.test`, `User ${i}`, 1_700_000_000 + i);
          }
        });
      },
    }),
    spec({
      name: "large/full-scan/10000",
      operation: "full scan",
      datasetSize: 10_000,
      tiers: ["default", "full"],
      warmup: 1,
      iterations: 6,
      setup: async (engine) => {
        await fillUsers(engine, 10_000);
        return engine.prepare("SELECT COUNT(*) AS c FROM users WHERE name LIKE 'User%'");
      },
      fn: async (_engine, ctx) => {
        await (ctx as BenchStatement).get();
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
      setup: async (engine) => {
        await fillUsers(engine, 10_000, true);
        return engine.prepare("SELECT id FROM users WHERE email = $1");
      },
      fn: async (_engine, ctx) => {
        const stmt = ctx as BenchStatement;
        for (let i = 0; i < 20; i++) await stmt.get(`u${100 + i * 10}@ex.test`);
      },
    }),
    spec({
      name: "large/full-scan/100000",
      operation: "full scan",
      datasetSize: 100_000,
      tiers: ["full"],
      warmup: 0,
      iterations: 3,
      setup: async (engine) => {
        await fillUsers(engine, 100_000);
        return engine.prepare("SELECT COUNT(*) AS c FROM users");
      },
      fn: async (_engine, ctx) => {
        await (ctx as BenchStatement).get();
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
      setup: async (engine) => {
        await fillUsers(engine, 100_000);
        return engine.prepare("SELECT id, name FROM users WHERE id = $1");
      },
      fn: async (_engine, ctx) => {
        const stmt = ctx as BenchStatement;
        for (let i = 0; i < 20; i++) await stmt.get(50_000 + i);
      },
    }),
  ];
}
