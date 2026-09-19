import path from "node:path";
import { pathToFileURL } from "node:url";
import { Database } from "../../src/index.ts";
import type { BenchSpec, BenchStatement } from "../harness/types.ts";
import { fillUsers, insertMany } from "./populate.ts";
import { spec } from "./tiers.ts";

const SOURCE_ENTRY_URL = pathToFileURL(path.join(import.meta.dir, "../../src/index.ts")).href;

export function startupSpecs(): BenchSpec[] {
  return [
    spec({
      name: "startup/new-database",
      operation: "new Database()",
      tiers: ["ci", "default", "full"],
      engines: "mem",
      warmup: 5,
      iterations: 40,
      fn: () => {
        const db = new Database();
        db.close();
      },
    }),
    spec({
      name: "startup/cold-import-first-query",
      operation: "Bun process + import + new Database() + first query",
      tiers: ["ci", "default", "full"],
      engines: "mem",
      warmup: 1,
      iterations: 8,
      fn: async () => {
        const script = `import { Database } from ${JSON.stringify(SOURCE_ENTRY_URL)}; const db = new Database(); db.query("SELECT 1"); db.close();`;
        const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "ignore", stderr: "pipe" });
        const code = await child.exited;
        if (code !== 0) throw new Error(`cold-start child exited ${code}: ${await new Response(child.stderr).text()}`);
      },
    }),
    spec({
      name: "startup/schema-plus-first-query",
      operation: "schema + first query",
      tiers: ["ci", "default", "full"],
      warmup: 1,
      iterations: 10,
      fn: async (engine) => {
        await engine.exec("DROP TABLE IF EXISTS t");
        await engine.exec("CREATE TABLE t (id serial PRIMARY KEY, name text)");
        await engine.exec("INSERT INTO t(name) VALUES ('a')");
        await engine.query("SELECT id, name FROM t");
      },
    }),
  ];
}

export function transactionSpecs(): BenchSpec[] {
  return [
    spec({
      name: "tx/individual-inserts/1000",
      operation: "1000 inserts autocommit",
      datasetSize: 1000,
      tiers: ["ci", "default", "full"],
      layer: "engine",
      isolateIterations: true,
      warmup: 0,
      iterations: 3,
      opsPerSample: 1000,
      setup: async (engine) => {
        await engine.exec("CREATE TABLE t (id serial PRIMARY KEY, v text)");
        return engine.prepare("INSERT INTO t(v) VALUES ($1)");
      },
      fn: async (_engine, ctx) => {
        const stmt = ctx as BenchStatement;
        for (let i = 0; i < 1000; i++) await stmt.run(`v${i}`);
      },
    }),
    spec({
      name: "tx/batched-inserts/1000",
      operation: "1000 inserts in transaction",
      datasetSize: 1000,
      tiers: ["ci", "default", "full"],
      layer: "engine",
      isolateIterations: true,
      warmup: 0,
      iterations: 3,
      opsPerSample: 1000,
      setup: async (engine) => {
        await engine.exec("CREATE TABLE t (id serial PRIMARY KEY, v text)");
        return engine.prepare("INSERT INTO t(v) VALUES ($1)");
      },
      fn: async (engine, ctx) => {
        const stmt = ctx as BenchStatement;
        await engine.transaction(async () => {
          for (let i = 0; i < 1000; i++) await stmt.run(`v${i}`);
        });
      },
    }),
    spec({
      name: "tx/batched-inserts/10000",
      operation: "10000 inserts in transaction",
      datasetSize: 10_000,
      tiers: ["default", "full"],
      layer: "engine",
      isolateIterations: true,
      warmup: 0,
      iterations: 2,
      opsPerSample: 10_000,
      setup: async (engine) => {
        await engine.exec("CREATE TABLE t (id serial PRIMARY KEY, v text)");
        return engine.prepare("INSERT INTO t(v) VALUES ($1)");
      },
      fn: async (engine, ctx) => {
        const stmt = ctx as BenchStatement;
        await engine.transaction(async () => {
          for (let i = 0; i < 10_000; i++) await stmt.run(`v${i}`);
        });
      },
    }),
    spec({
      name: "tx/update-batch/1000",
      operation: "batch update",
      datasetSize: 1000,
      tiers: ["default", "full"],
      layer: "engine",
      isolateIterations: true,
      warmup: 0,
      iterations: 4,
      setup: async (engine) => {
        await engine.exec("CREATE TABLE t (id int PRIMARY KEY, v int)");
        await insertMany(engine, "INSERT INTO t(id, v) VALUES ($1, $2)", 1000, (i) => [i, 0]);
        return engine.prepare("UPDATE t SET v = v + 1 WHERE id = $1");
      },
      fn: async (engine, ctx) => {
        const stmt = ctx as BenchStatement;
        await engine.transaction(async () => {
          for (let i = 1; i <= 100; i++) await stmt.run(i);
        });
      },
    }),
    spec({
      name: "tx/savepoint-rollback/1000",
      operation: "savepoint rollback",
      datasetSize: 1000,
      tiers: ["default", "full"],
      layer: "engine",
      isolateIterations: true,
      warmup: 0,
      iterations: 4,
      setup: async (engine) => {
        await engine.exec("CREATE TABLE t (id int PRIMARY KEY, v text)");
        await insertMany(engine, "INSERT INTO t(id, v) VALUES ($1, $2)", 1000, (i) => [i, "x"]);
      },
      fn: async (engine) => {
        // Postgres requires savepoints inside a transaction block.
        await engine.exec("BEGIN");
        await engine.exec("SAVEPOINT sp1");
        await engine.exec("UPDATE t SET v = 'y' WHERE id = 1");
        await engine.exec("ROLLBACK TO SAVEPOINT sp1");
        await engine.exec("RELEASE SAVEPOINT sp1");
        await engine.exec("COMMIT");
      },
    }),
  ];
}

export function indexSpecs(): BenchSpec[] {
  return [
    spec({
      name: "index/pk-lookup/1000",
      operation: "primary key lookup",
      datasetSize: 1000,
      tiers: ["ci", "default", "full"],
      warmup: 2,
      iterations: 20,
      opsPerSample: 20,
      setup: async (engine) => {
        await fillUsers(engine, 1000, false);
        return engine.prepare("SELECT * FROM users WHERE id = $1");
      },
      fn: async (_engine, ctx) => {
        const stmt = ctx as BenchStatement;
        for (let i = 0; i < 20; i++) await stmt.get(100 + i);
      },
    }),
    spec({
      name: "index/unique-email/1000",
      operation: "unique index lookup",
      datasetSize: 1000,
      tiers: ["ci", "default", "full"],
      warmup: 2,
      iterations: 20,
      opsPerSample: 20,
      setup: async (engine) => {
        await fillUsers(engine, 1000, true);
        return engine.prepare("SELECT * FROM users WHERE email = $1");
      },
      fn: async (_engine, ctx) => {
        const stmt = ctx as BenchStatement;
        for (let i = 0; i < 20; i++) await stmt.get(`u${100 + i}@ex.test`);
      },
    }),
    spec({
      name: "index/no-index-email/1000",
      operation: "unindexed lookup",
      datasetSize: 1000,
      tiers: ["default", "full"],
      warmup: 2,
      iterations: 12,
      opsPerSample: 20,
      setup: async (engine) => {
        await fillUsers(engine, 1000, false);
        return engine.prepare("SELECT * FROM users WHERE email = $1");
      },
      fn: async (_engine, ctx) => {
        const stmt = ctx as BenchStatement;
        for (let i = 0; i < 20; i++) await stmt.get(`u${100 + i}@ex.test`);
      },
    }),
    spec({
      name: "index/create/1000",
      operation: "CREATE INDEX",
      datasetSize: 1000,
      tiers: ["default", "full"],
      warmup: 0,
      iterations: 1,
      setup: (engine) => fillUsers(engine, 1000, false),
      fn: async (engine) => {
        await engine.exec("CREATE UNIQUE INDEX idx_users_email ON users(email)");
      },
    }),
    spec({
      name: "index/composite-pk/1000",
      operation: "composite primary key lookup",
      datasetSize: 1000,
      tiers: ["default", "full"],
      layer: "engine",
      warmup: 2,
      iterations: 12,
      opsPerSample: 20,
      setup: async (engine) => {
        await engine.exec("CREATE TABLE kv (a int NOT NULL, b int NOT NULL, v text, PRIMARY KEY (a, b))");
        await insertMany(engine, "INSERT INTO kv(a, b, v) VALUES ($1, $2, $3)", 1000, (i) => [i, i % 10, `v${i}`]);
        return engine.prepare("SELECT v FROM kv WHERE a = $1 AND b = $2");
      },
      fn: async (_engine, ctx) => {
        const stmt = ctx as BenchStatement;
        for (let i = 0; i < 20; i++) await stmt.get(50 + i, (50 + i) % 10);
      },
    }),
    spec({
      name: "index/composite-unique/1000",
      operation: "composite unique index lookup",
      datasetSize: 1000,
      tiers: ["default", "full"],
      layer: "engine",
      warmup: 2,
      iterations: 12,
      opsPerSample: 20,
      setup: async (engine) => {
        await engine.exec("CREATE TABLE kv (a int NOT NULL, b int NOT NULL, v text)");
        await engine.exec("CREATE UNIQUE INDEX idx_kv_ab ON kv(a, b)");
        await insertMany(engine, "INSERT INTO kv(a, b, v) VALUES ($1, $2, $3)", 1000, (i) => [i, i % 10, `v${i}`]);
        return engine.prepare("SELECT v FROM kv WHERE a = $1 AND b = $2");
      },
      fn: async (_engine, ctx) => {
        const stmt = ctx as BenchStatement;
        for (let i = 0; i < 20; i++) await stmt.get(50 + i, (50 + i) % 10);
      },
    }),
  ];
}

export function joinSpecs(): BenchSpec[] {
  return [
    spec({
      name: "join/small-large/1000",
      operation: "join small to large",
      datasetSize: 1000,
      tiers: ["ci", "default", "full"],
      layer: "engine",
      warmup: 1,
      iterations: 8,
      setup: async (engine) => {
        await engine.exec("CREATE TABLE small (id int PRIMARY KEY, k int NOT NULL)");
        await engine.exec("CREATE TABLE large (id int PRIMARY KEY, k int NOT NULL, label text)");
        await engine.exec("CREATE UNIQUE INDEX idx_large_k ON large(k)");
        const insS = engine.prepare("INSERT INTO small(id, k) VALUES ($1, $2)");
        const insL = engine.prepare("INSERT INTO large(id, k, label) VALUES ($1, $2, $3)");
        await engine.transaction(async () => {
          for (let i = 1; i <= 20; i++) await insS.run(i, i);
          for (let i = 1; i <= 1000; i++) await insL.run(i, i, `L${i}`);
        });
        return engine.prepare("SELECT small.id, large.label FROM small JOIN large ON large.k = small.k");
      },
      fn: async (_engine, ctx) => {
        await (ctx as BenchStatement).all();
      },
    }),
    spec({
      name: "join/string-keys/500",
      operation: "join on strings",
      datasetSize: 500,
      tiers: ["default", "full"],
      layer: "engine",
      warmup: 1,
      iterations: 6,
      setup: async (engine) => {
        await engine.exec("CREATE TABLE a (id int PRIMARY KEY, k text NOT NULL)");
        await engine.exec("CREATE TABLE b (id int PRIMARY KEY, k text NOT NULL)");
        await engine.exec("CREATE UNIQUE INDEX idx_b_k ON b(k)");
        const insA = engine.prepare("INSERT INTO a(id, k) VALUES ($1, $2)");
        const insB = engine.prepare("INSERT INTO b(id, k) VALUES ($1, $2)");
        await engine.transaction(async () => {
          for (let i = 1; i <= 500; i++) {
            await insA.run(i, `k${i}`);
            await insB.run(i, `k${i}`);
          }
        });
        return engine.prepare("SELECT a.id FROM a JOIN b ON a.k = b.k");
      },
      fn: async (_engine, ctx) => {
        await (ctx as BenchStatement).all();
      },
    }),
    spec({
      name: "join/with-nulls/500",
      operation: "LEFT JOIN with nulls (indexed)",
      datasetSize: 500,
      tiers: ["default", "full"],
      layer: "engine",
      warmup: 1,
      iterations: 6,
      setup: async (engine) => {
        await engine.exec("CREATE TABLE a (id int PRIMARY KEY, k int)");
        await engine.exec("CREATE TABLE b (id int PRIMARY KEY, k int)");
        await engine.exec("CREATE INDEX idx_b_k ON b(k)");
        const insA = engine.prepare("INSERT INTO a(id, k) VALUES ($1, $2)");
        const insB = engine.prepare("INSERT INTO b(id, k) VALUES ($1, $2)");
        await engine.transaction(async () => {
          for (let i = 1; i <= 500; i++) {
            await insA.run(i, i % 7 === 0 ? null : i);
            await insB.run(i, i % 11 === 0 ? null : i);
          }
        });
        return engine.prepare("SELECT a.id FROM a LEFT JOIN b ON a.k = b.k");
      },
      fn: async (_engine, ctx) => {
        await (ctx as BenchStatement).all();
      },
    }),
    spec({
      name: "join/unindexed-eq/500",
      operation: "unindexed equality join (hash fallback)",
      datasetSize: 500,
      tiers: ["default", "full"],
      layer: "engine",
      warmup: 1,
      iterations: 6,
      setup: async (engine) => {
        await engine.exec("CREATE TABLE a (id int PRIMARY KEY, k int NOT NULL)");
        await engine.exec("CREATE TABLE b (id int PRIMARY KEY, k int NOT NULL)");
        const insA = engine.prepare("INSERT INTO a(id, k) VALUES ($1, $2)");
        const insB = engine.prepare("INSERT INTO b(id, k) VALUES ($1, $2)");
        await engine.transaction(async () => {
          for (let i = 1; i <= 500; i++) {
            await insA.run(i, i);
            await insB.run(i, i);
          }
        });
        return engine.prepare("SELECT a.id FROM a JOIN b ON a.k = b.k");
      },
      fn: async (_engine, ctx) => {
        await (ctx as BenchStatement).all();
      },
    }),
  ];
}

/** GROUP BY / ORDER BY / window functions / CTEs / string & date functions. */
export function analyticsSpecs(): BenchSpec[] {
  const fillEvents = async (engine: Parameters<NonNullable<BenchSpec["setup"]>>[0], n: number): Promise<void> => {
    await engine.exec("CREATE TABLE events (id int PRIMARY KEY, bucket int NOT NULL, n int NOT NULL)");
    await insertMany(engine, "INSERT INTO events(id, bucket, n) VALUES ($1, $2, $3)", n, (i) => [i, i % 20, i % 7]);
  };

  return [
    spec({
      name: "engine/group-by-having/1000",
      operation: "GROUP BY + HAVING",
      datasetSize: 1000,
      tiers: ["ci", "default", "full"],
      layer: "engine",
      warmup: 2,
      iterations: 12,
      setup: async (engine) => {
        await fillEvents(engine, 1000);
        return engine.prepare(
          "SELECT bucket, COUNT(*) AS c, SUM(n) AS s FROM events GROUP BY bucket HAVING COUNT(*) > 10 ORDER BY bucket",
        );
      },
      fn: async (_engine, ctx) => {
        await (ctx as BenchStatement).all();
      },
    }),
    spec({
      name: "engine/order-by-multi/1000",
      operation: "ORDER BY two keys LIMIT 50",
      datasetSize: 1000,
      tiers: ["ci", "default", "full"],
      layer: "engine",
      warmup: 2,
      iterations: 12,
      setup: async (engine) => {
        await fillEvents(engine, 1000);
        return engine.prepare("SELECT id, bucket, n FROM events ORDER BY bucket ASC, n DESC LIMIT 50");
      },
      fn: async (_engine, ctx) => {
        await (ctx as BenchStatement).all();
      },
    }),
    spec({
      name: "engine/window-row-number/1000",
      operation: "ROW_NUMBER() OVER (PARTITION BY ...)",
      datasetSize: 1000,
      tiers: ["ci", "default", "full"],
      layer: "engine",
      warmup: 1,
      iterations: 8,
      setup: async (engine) => {
        await fillEvents(engine, 1000);
        return engine.prepare(
          "SELECT id, bucket, ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY n DESC, id) AS rn FROM events",
        );
      },
      fn: async (_engine, ctx) => {
        await (ctx as BenchStatement).all();
      },
    }),
    spec({
      name: "engine/window-running-sum/1000",
      operation: "SUM(n) OVER (ORDER BY id)",
      datasetSize: 1000,
      tiers: ["ci", "default", "full"],
      layer: "engine",
      warmup: 1,
      iterations: 8,
      setup: async (engine) => {
        await fillEvents(engine, 1000);
        return engine.prepare("SELECT id, SUM(n) OVER (ORDER BY id) AS running FROM events");
      },
      fn: async (_engine, ctx) => {
        await (ctx as BenchStatement).all();
      },
    }),
    spec({
      name: "engine/window-rank-lag/1000",
      operation: "RANK() + LAG() over partitions",
      datasetSize: 1000,
      tiers: ["default", "full"],
      layer: "engine",
      warmup: 1,
      iterations: 8,
      setup: async (engine) => {
        await fillEvents(engine, 1000);
        return engine.prepare(
          "SELECT id, RANK() OVER (PARTITION BY bucket ORDER BY n DESC) AS r, LAG(n) OVER (PARTITION BY bucket ORDER BY id) AS prev FROM events",
        );
      },
      fn: async (_engine, ctx) => {
        await (ctx as BenchStatement).all();
      },
    }),
    spec({
      name: "engine/cte-join/1000",
      operation: "CTE + join",
      datasetSize: 1000,
      tiers: ["ci", "default", "full"],
      layer: "engine",
      warmup: 1,
      iterations: 8,
      setup: async (engine) => {
        await fillEvents(engine, 1000);
        return engine.prepare(
          "WITH busy AS (SELECT bucket FROM events GROUP BY bucket HAVING COUNT(*) > 10) SELECT COUNT(*) AS c FROM events e JOIN busy b ON e.bucket = b.bucket",
        );
      },
      fn: async (_engine, ctx) => {
        await (ctx as BenchStatement).get();
      },
    }),
    spec({
      name: "engine/recursive-cte/100",
      operation: "WITH RECURSIVE series",
      datasetSize: 100,
      tiers: ["ci", "default", "full"],
      layer: "engine",
      warmup: 2,
      iterations: 12,
      setup: (engine) =>
        engine.prepare(
          "WITH RECURSIVE series(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM series WHERE n < 100) SELECT SUM(n) AS s FROM series",
        ),
      fn: async (_engine, ctx) => {
        await (ctx as BenchStatement).get();
      },
    }),
    spec({
      name: "engine/string-fns/1000",
      operation: "upper/lower/length/substring/concat",
      datasetSize: 1000,
      tiers: ["ci", "default", "full"],
      layer: "engine",
      warmup: 1,
      iterations: 8,
      setup: async (engine) => {
        await fillUsers(engine, 1000);
        return engine.prepare(
          "SELECT upper(name) AS u, lower(email) AS l, length(name) AS len, substring(email, 1, 5) AS pre, name || ' <' || email || '>' AS display FROM users WHERE id > $1 LIMIT 100",
        );
      },
      fn: async (_engine, ctx) => {
        await (ctx as BenchStatement).all(500);
      },
    }),
    spec({
      name: "engine/date-fns/1000",
      operation: "date_trunc/extract/to_char",
      datasetSize: 1000,
      tiers: ["ci", "default", "full"],
      layer: "engine",
      warmup: 1,
      iterations: 8,
      setup: async (engine) => {
        await engine.exec("CREATE TABLE stamps (id int PRIMARY KEY, ts timestamp NOT NULL)");
        await insertMany(engine, "INSERT INTO stamps(id, ts) VALUES ($1, $2::timestamp)", 1000, (i) => [
          i,
          `2024-01-${String((i % 28) + 1).padStart(2, "0")} ${String(i % 24).padStart(2, "0")}:30:00`,
        ]);
        return engine.prepare(
          "SELECT date_trunc('day', ts) AS d, extract(hour FROM ts) AS h, to_char(ts, 'YYYY-MM-DD') AS s FROM stamps WHERE id = $1",
        );
      },
      fn: async (_engine, ctx) => {
        await (ctx as BenchStatement).get(500);
      },
    }),
    spec({
      name: "engine/generate-series/1000",
      operation: "generate_series table function",
      datasetSize: 1000,
      tiers: ["default", "full"],
      layer: "engine",
      warmup: 1,
      iterations: 8,
      setup: (engine) => engine.prepare("SELECT SUM(g) AS s FROM generate_series(1, 1000) AS g"),
      fn: async (_engine, ctx) => {
        await (ctx as BenchStatement).get();
      },
    }),
  ];
}
