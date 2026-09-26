import type { BenchSpec, BenchStatement } from "../harness/types.ts";
import { fillUsers, type PreparedCtx, pkLookupCtx } from "./populate.ts";
import { spec, tiersForSize } from "./tiers.ts";

const SIZES = [100, 1_000, 10_000, 100_000];

export function microSpecs(): BenchSpec[] {
  const specs: BenchSpec[] = [];

  for (const n of SIZES) {
    const tiers = tiersForSize(n);
    const iterations = n >= 100_000 ? 8 : 25;
    const warmup = n >= 100_000 ? 1 : 5;

    specs.push(
      spec({
        name: `micro/trivial-select/${n}`,
        operation: "SELECT 1",
        datasetSize: n,
        tiers,
        warmup,
        iterations,
        opsPerSample: 20,
        setup: (engine) => fillUsers(engine, n),
        fn: async (engine) => {
          for (let i = 0; i < 20; i++) await engine.query("SELECT 1 AS x");
        },
      }),
      spec({
        name: `micro/pk-lookup/${n}`,
        operation: "pk lookup",
        datasetSize: n,
        tiers,
        warmup,
        iterations,
        opsPerSample: 10,
        setup: (engine) => pkLookupCtx(engine, n),
        fn: async (_engine, ctx) => {
          const { stmt, id } = ctx as PreparedCtx;
          for (let i = 0; i < 10; i++) await stmt.get(id);
        },
      }),
      spec({
        name: `micro/indexed-lookup/${n}`,
        operation: "indexed email lookup",
        datasetSize: n,
        tiers,
        warmup,
        iterations,
        opsPerSample: 10,
        setup: async (engine) => {
          await fillUsers(engine, n, true);
          return {
            stmt: engine.prepare("SELECT id, name FROM users WHERE email = $1"),
            email: `u${Math.max(1, Math.floor(n / 2))}@ex.test`,
          };
        },
        fn: async (_engine, ctx) => {
          const { stmt, email } = ctx as { stmt: BenchStatement; email: string };
          for (let i = 0; i < 10; i++) await stmt.get(email);
        },
      }),
      spec({
        name: `micro/unindexed-filter/${n}`,
        operation: "unindexed filter",
        datasetSize: n,
        tiers,
        warmup,
        iterations: n >= 10_000 ? 6 : iterations,
        setup: async (engine) => {
          await fillUsers(engine, n, false);
          return engine.prepare("SELECT id FROM users WHERE name = $1");
        },
        fn: async (_engine, ctx) => {
          await (ctx as BenchStatement).all(`User ${Math.max(1, Math.floor(n / 3))}`);
        },
      }),
      spec({
        name: `micro/insert/${n}`,
        operation: "single insert",
        datasetSize: n,
        tiers,
        warmup: 0,
        iterations: 1,
        opsPerSample: 200,
        setup: async (engine) => {
          await fillUsers(engine, n);
          return {
            stmt: engine.prepare("INSERT INTO users(email, name, created_at) VALUES ($1, $2, $3)"),
            next: n + 1,
          };
        },
        fn: async (engine, ctx) => {
          const state = ctx as { stmt: BenchStatement; next: number };
          await engine.transaction(async () => {
            for (let i = 0; i < 200; i++) {
              const id = state.next++;
              await state.stmt.run(`u${id}@ex.test`, `User ${id}`, 1_700_000_000 + id);
            }
          });
        },
      }),
      spec({
        name: `micro/update/${n}`,
        operation: "pk update",
        datasetSize: n,
        tiers,
        warmup,
        iterations,
        opsPerSample: 10,
        setup: async (engine) => {
          await fillUsers(engine, n);
          return {
            stmt: engine.prepare("UPDATE users SET name = $1 WHERE id = $2"),
            id: Math.max(1, Math.floor(n / 2)),
          };
        },
        fn: async (_engine, ctx) => {
          const { stmt, id } = ctx as { stmt: BenchStatement; id: number };
          for (let i = 0; i < 10; i++) await stmt.run(`Updated ${i}`, id);
        },
      }),
      spec({
        name: `micro/delete-reinsert/${n}`,
        operation: "delete+insert",
        datasetSize: n,
        tiers,
        warmup,
        iterations,
        setup: async (engine) => {
          await fillUsers(engine, n);
          return {
            del: engine.prepare("DELETE FROM users WHERE id = $1"),
            ins: engine.prepare("INSERT INTO users(id, email, name, created_at) VALUES ($1, $2, $3, $4)"),
            id: n,
          };
        },
        fn: async (_engine, ctx) => {
          const { del, ins, id } = ctx as { del: BenchStatement; ins: BenchStatement; id: number };
          await del.run(id);
          await ins.run(id, `u${id}@ex.test`, `User ${id}`, 1_700_000_000 + id);
        },
      }),
      spec({
        name: `micro/filter-select/${n}`,
        operation: "SELECT with filter",
        datasetSize: n,
        tiers,
        warmup,
        iterations: n >= 10_000 ? 6 : iterations,
        setup: async (engine) => {
          await fillUsers(engine, n);
          return engine.prepare("SELECT id, name FROM users WHERE created_at > $1");
        },
        fn: async (_engine, ctx) => {
          await (ctx as BenchStatement).all(1_700_000_000 + Math.floor(n / 2));
        },
      }),
      spec({
        name: `micro/order-by/${n}`,
        operation: "ORDER BY",
        datasetSize: n,
        tiers,
        warmup,
        iterations: n >= 10_000 ? 6 : iterations,
        setup: async (engine) => {
          await fillUsers(engine, n);
          return engine.prepare("SELECT id, name FROM users ORDER BY name DESC LIMIT 50");
        },
        fn: async (_engine, ctx) => {
          await (ctx as BenchStatement).all();
        },
      }),
      spec({
        name: `micro/group-by/${n}`,
        operation: "GROUP BY",
        datasetSize: n,
        tiers,
        warmup,
        iterations: n >= 10_000 ? 6 : iterations,
        setup: async (engine) => {
          await engine.exec("CREATE TABLE events (id int PRIMARY KEY, bucket int NOT NULL, n int NOT NULL)");
          const stmt = engine.prepare("INSERT INTO events(id, bucket, n) VALUES ($1, $2, $3)");
          await engine.transaction(async () => {
            for (let i = 1; i <= n; i++) await stmt.run(i, i % 20, i % 7);
          });
          return engine.prepare("SELECT bucket, COUNT(*) AS c, SUM(n) AS s FROM events GROUP BY bucket");
        },
        fn: async (_engine, ctx) => {
          await (ctx as BenchStatement).all();
        },
      }),
      spec({
        name: `micro/join/${n}`,
        operation: "JOIN",
        datasetSize: n,
        tiers,
        warmup,
        iterations: n >= 10_000 ? 4 : iterations,
        setup: async (engine) => {
          await engine.exec("CREATE TABLE a (id int PRIMARY KEY, k int NOT NULL)");
          await engine.exec("CREATE TABLE b (id int PRIMARY KEY, k int NOT NULL, label text)");
          await engine.exec("CREATE INDEX idx_b_k ON b(k)");
          const insA = engine.prepare("INSERT INTO a(id, k) VALUES ($1, $2)");
          const insB = engine.prepare("INSERT INTO b(id, k, label) VALUES ($1, $2, $3)");
          const bCount = Math.max(10, Math.floor(n / 10));
          await engine.transaction(async () => {
            for (let i = 1; i <= n; i++) await insA.run(i, (i % bCount) + 1);
            for (let i = 1; i <= bCount; i++) await insB.run(i, i, `L${i}`);
          });
          return engine.prepare("SELECT a.id, b.label FROM a JOIN b ON a.k = b.k LIMIT 100");
        },
        fn: async (_engine, ctx) => {
          await (ctx as BenchStatement).all();
        },
      }),
      spec({
        name: `micro/aggregate/${n}`,
        operation: "aggregate",
        datasetSize: n,
        tiers,
        warmup,
        iterations: n >= 10_000 ? 6 : iterations,
        setup: async (engine) => {
          await fillUsers(engine, n);
          return engine.prepare("SELECT COUNT(*), MIN(id), MAX(id) FROM users");
        },
        fn: async (_engine, ctx) => {
          await (ctx as BenchStatement).get();
        },
      }),
      spec({
        name: `micro/subquery/${n}`,
        operation: "subquery",
        datasetSize: n,
        tiers,
        warmup,
        iterations: n >= 10_000 ? 4 : iterations,
        setup: async (engine) => {
          await fillUsers(engine, n);
          return engine.prepare("SELECT id, name FROM users WHERE id = (SELECT MAX(id) FROM users)");
        },
        fn: async (_engine, ctx) => {
          await (ctx as BenchStatement).get();
        },
      }),
      spec({
        name: `micro/cte/${n}`,
        operation: "CTE",
        datasetSize: n,
        tiers,
        warmup,
        iterations: n >= 10_000 ? 4 : iterations,
        setup: async (engine) => {
          await fillUsers(engine, n);
          return engine.prepare(
            "WITH recent AS (SELECT id, name FROM users WHERE id > $1) SELECT COUNT(*) AS c FROM recent",
          );
        },
        fn: async (_engine, ctx) => {
          await (ctx as BenchStatement).get(Math.floor(n / 2));
        },
      }),
    );
  }

  specs.push(
    spec({
      name: "micro/prepared-execute/1000",
      operation: "prepared execute",
      datasetSize: 1000,
      tiers: ["ci", "default", "full"],
      warmup: 3,
      iterations: 8,
      opsPerSample: 1000,
      setup: async (engine) => {
        await fillUsers(engine, 1000);
        return engine.prepare("SELECT id, name FROM users WHERE id = $1");
      },
      fn: async (_engine, ctx) => {
        const stmt = ctx as BenchStatement;
        for (let i = 1; i <= 1000; i++) await stmt.get(i);
      },
    }),
    spec({
      name: "micro/prepare-plus-execute/1000",
      operation: "prepare+execute",
      datasetSize: 1000,
      tiers: ["default", "full"],
      warmup: 1,
      iterations: 8,
      opsPerSample: 50,
      setup: (engine) => fillUsers(engine, 1000),
      fn: async (engine) => {
        for (let i = 1; i <= 50; i++) {
          const stmt = engine.prepare("SELECT id, name FROM users WHERE id = $1");
          await stmt.get(i);
        }
      },
    }),
    spec({
      name: "micro/prepared-execute/10000",
      operation: "prepared execute",
      datasetSize: 10_000,
      tiers: ["full"],
      warmup: 1,
      iterations: 4,
      opsPerSample: 10_000,
      setup: async (engine) => {
        await fillUsers(engine, 10_000);
        return engine.prepare("SELECT id FROM users WHERE id = $1");
      },
      fn: async (_engine, ctx) => {
        const stmt = ctx as BenchStatement;
        for (let i = 1; i <= 10_000; i++) await stmt.get(((i * 17) % 10_000) + 1);
      },
    }),
    spec({
      name: "micro/prepared-execute/100000",
      operation: "prepared execute",
      datasetSize: 100_000,
      tiers: ["full"],
      warmup: 0,
      iterations: 1,
      opsPerSample: 100_000,
      setup: async (engine) => {
        await fillUsers(engine, 100_000);
        return engine.prepare("SELECT id FROM users WHERE id = $1");
      },
      fn: async (_engine, ctx) => {
        const stmt = ctx as BenchStatement;
        for (let i = 1; i <= 100_000; i++) await stmt.get(((i * 17) % 100_000) + 1);
      },
    }),
  );

  return specs;
}
