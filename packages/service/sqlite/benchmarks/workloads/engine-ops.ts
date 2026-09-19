import path from "node:path";
import { pathToFileURL } from "node:url";
import { Database } from "../../src/index.ts";
import { parse } from "../../src/unstable.ts";
import type { BenchSpec } from "../harness/types.ts";
import { fillUsers } from "./populate.ts";
import { spec } from "./tiers.ts";

const SQLS = [
  "SELECT 1",
  "SELECT id, name FROM users WHERE id = ?",
  "SELECT u.name, COUNT(t.id) FROM users u JOIN tasks t ON t.assignee_id = u.id GROUP BY u.id",
  "INSERT INTO users(email, name, created_at) VALUES (?, ?, ?)",
  "WITH x AS (SELECT id FROM users WHERE id > 10) SELECT COUNT(*) FROM x",
];

const SOURCE_ENTRY_URL = pathToFileURL(path.join(import.meta.dir, "../../src/index.ts")).href;

export function parserSpecs(): BenchSpec[] {
  return [
    spec({
      name: "parser/parse-select",
      operation: "parse(sql)",
      tiers: ["ci", "default", "full"],
      engines: "mem",
      warmup: 5,
      iterations: 40,
      opsPerSample: SQLS.length,
      fn: () => {
        for (const sql of SQLS) parse(sql);
      },
    }),
    spec({
      name: "parser/prepare",
      operation: "prepare(sql)",
      datasetSize: 100,
      tiers: ["ci", "default", "full"],
      warmup: 3,
      iterations: 20,
      setup: (engine) => fillUsers(engine, 100),
      fn: (engine) => {
        engine.prepare("SELECT id, name FROM users WHERE id = ?");
      },
    }),
    spec({
      name: "parser/execute-prepared",
      operation: "execute prepared",
      datasetSize: 100,
      tiers: ["ci", "default", "full"],
      warmup: 3,
      iterations: 30,
      opsPerSample: 20,
      setup: (engine) => {
        fillUsers(engine, 100);
        return engine.prepare("SELECT id, name FROM users WHERE id = ?");
      },
      fn: (_engine, ctx) => {
        const stmt = ctx as { get: (id: number) => unknown };
        for (let i = 0; i < 20; i++) stmt.get(50);
      },
    }),
    spec({
      name: "parser/execute-reparse",
      operation: "parse + execute each query",
      datasetSize: 100,
      tiers: ["ci", "default", "full"],
      warmup: 3,
      iterations: 30,
      opsPerSample: 20,
      setup: (engine) => fillUsers(engine, 100),
      fn: (engine) => {
        for (let i = 0; i < 20; i++) engine.query("SELECT id, name FROM users WHERE id = ?", [50]);
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
      setup: (engine) => {
        engine.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
        return engine.prepare("INSERT INTO t(v) VALUES (?)");
      },
      fn: (_engine, ctx) => {
        const stmt = ctx as { run: (v: string) => unknown };
        for (let i = 0; i < 1000; i++) stmt.run(`v${i}`);
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
      setup: (engine) => {
        engine.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
        return engine.prepare("INSERT INTO t(v) VALUES (?)");
      },
      fn: (engine, ctx) => {
        const stmt = ctx as { run: (v: string) => unknown };
        engine.transaction(() => {
          for (let i = 0; i < 1000; i++) stmt.run(`v${i}`);
        });
      },
    }),
    spec({
      name: "tx/prepared-tx-inserts/1000",
      operation: "1000 prepared inserts in transaction",
      datasetSize: 1000,
      tiers: ["default", "full"],
      layer: "engine",
      isolateIterations: true,
      warmup: 0,
      iterations: 3,
      opsPerSample: 1000,
      setup: (engine) => {
        engine.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
        return engine.prepare("INSERT INTO t(v) VALUES (?)");
      },
      fn: (engine, ctx) => {
        const stmt = ctx as { run: (v: string) => unknown };
        engine.transaction(() => {
          for (let i = 0; i < 1000; i++) stmt.run(`v${i}`);
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
      setup: (engine) => {
        engine.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
        return engine.prepare("INSERT INTO t(v) VALUES (?)");
      },
      fn: (engine, ctx) => {
        const stmt = ctx as { run: (v: string) => unknown };
        engine.transaction(() => {
          for (let i = 0; i < 10_000; i++) stmt.run(`v${i}`);
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
      setup: (engine) => {
        engine.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)");
        const ins = engine.prepare("INSERT INTO t(id, v) VALUES (?, ?)");
        engine.transaction(() => {
          for (let i = 1; i <= 1000; i++) ins.run(i, 0);
        });
        return engine.prepare("UPDATE t SET v = v + 1 WHERE id = ?");
      },
      fn: (engine, ctx) => {
        const stmt = ctx as { run: (id: number) => unknown };
        engine.transaction(() => {
          for (let i = 1; i <= 100; i++) stmt.run(i);
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
      setup: (engine) => {
        engine.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
        const ins = engine.prepare("INSERT INTO t(id, v) VALUES (?, ?)");
        engine.transaction(() => {
          for (let i = 1; i <= 1000; i++) ins.run(i, "x");
        });
      },
      fn: (engine) => {
        engine.exec("SAVEPOINT sp1");
        engine.exec("UPDATE t SET v = 'y' WHERE id = 1");
        engine.exec("ROLLBACK TO sp1");
        engine.exec("RELEASE sp1");
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
      setup: (engine) => {
        fillUsers(engine, 1000, false);
        return engine.prepare("SELECT * FROM users WHERE id = ?");
      },
      fn: (_engine, ctx) => {
        const stmt = ctx as { get: (id: number) => unknown };
        for (let i = 0; i < 20; i++) stmt.get(100 + i);
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
      setup: (engine) => {
        fillUsers(engine, 1000, true);
        return engine.prepare("SELECT * FROM users WHERE email = ?");
      },
      fn: (_engine, ctx) => {
        const stmt = ctx as { get: (e: string) => unknown };
        for (let i = 0; i < 20; i++) stmt.get(`u${100 + i}@ex.test`);
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
      setup: (engine) => {
        fillUsers(engine, 1000, false);
        return engine.prepare("SELECT * FROM users WHERE email = ?");
      },
      fn: (_engine, ctx) => {
        const stmt = ctx as { get: (e: string) => unknown };
        for (let i = 0; i < 20; i++) stmt.get(`u${100 + i}@ex.test`);
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
      fn: (engine) => {
        engine.exec("CREATE UNIQUE INDEX idx_users_email ON users(email)");
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
      setup: (engine) => {
        engine.exec("CREATE TABLE kv (a INTEGER NOT NULL, b INTEGER NOT NULL, v TEXT, PRIMARY KEY (a, b))");
        const ins = engine.prepare("INSERT INTO kv(a, b, v) VALUES (?, ?, ?)");
        engine.transaction(() => {
          for (let i = 1; i <= 1000; i++) ins.run(i, i % 10, `v${i}`);
        });
        return engine.prepare("SELECT v FROM kv WHERE a = ? AND b = ?");
      },
      fn: (_engine, ctx) => {
        const stmt = ctx as { get: (a: number, b: number) => unknown };
        for (let i = 0; i < 20; i++) stmt.get(50 + i, (50 + i) % 10);
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
      setup: (engine) => {
        engine.exec("CREATE TABLE kv (a INTEGER NOT NULL, b INTEGER NOT NULL, v TEXT)");
        engine.exec("CREATE UNIQUE INDEX idx_kv_ab ON kv(a, b)");
        const ins = engine.prepare("INSERT INTO kv(a, b, v) VALUES (?, ?, ?)");
        engine.transaction(() => {
          for (let i = 1; i <= 1000; i++) ins.run(i, i % 10, `v${i}`);
        });
        return engine.prepare("SELECT v FROM kv WHERE a = ? AND b = ?");
      },
      fn: (_engine, ctx) => {
        const stmt = ctx as { get: (a: number, b: number) => unknown };
        for (let i = 0; i < 20; i++) stmt.get(50 + i, (50 + i) % 10);
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
      setup: (engine) => {
        engine.exec("CREATE TABLE small (id INTEGER PRIMARY KEY, k INTEGER NOT NULL)");
        engine.exec("CREATE TABLE large (id INTEGER PRIMARY KEY, k INTEGER NOT NULL, label TEXT)");
        engine.exec("CREATE UNIQUE INDEX idx_large_k ON large(k)");
        const insS = engine.prepare("INSERT INTO small(id, k) VALUES (?, ?)");
        const insL = engine.prepare("INSERT INTO large(id, k, label) VALUES (?, ?, ?)");
        engine.transaction(() => {
          for (let i = 1; i <= 20; i++) insS.run(i, i);
          for (let i = 1; i <= 1000; i++) insL.run(i, i, `L${i}`);
        });
        return engine.prepare("SELECT small.id, large.label FROM small JOIN large ON large.k = small.k");
      },
      fn: (_engine, ctx) => {
        (ctx as { all: () => unknown }).all();
      },
    }),
    spec({
      name: "join/small-large/100000",
      operation: "join small to large",
      datasetSize: 100_000,
      tiers: ["full"],
      layer: "engine",
      warmup: 1,
      iterations: 6,
      setup: (engine) => {
        engine.exec("CREATE TABLE small (id INTEGER PRIMARY KEY, k INTEGER NOT NULL)");
        engine.exec("CREATE TABLE large (id INTEGER PRIMARY KEY, k INTEGER NOT NULL, label TEXT)");
        engine.exec("CREATE UNIQUE INDEX idx_large_k ON large(k)");
        const insS = engine.prepare("INSERT INTO small(id, k) VALUES (?, ?)");
        const insL = engine.prepare("INSERT INTO large(id, k, label) VALUES (?, ?, ?)");
        engine.transaction(() => {
          for (let i = 1; i <= 100; i++) insS.run(i, i * 997);
          for (let i = 1; i <= 100_000; i++) insL.run(i, i, `L${i}`);
        });
        return engine.prepare("SELECT small.id, large.label FROM small JOIN large ON large.k = small.k");
      },
      fn: (_engine, ctx) => {
        (ctx as { all: () => unknown }).all();
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
      setup: (engine) => {
        engine.exec("CREATE TABLE a (id INTEGER PRIMARY KEY, k TEXT NOT NULL)");
        engine.exec("CREATE TABLE b (id INTEGER PRIMARY KEY, k TEXT NOT NULL)");
        engine.exec("CREATE UNIQUE INDEX idx_b_k ON b(k)");
        const insA = engine.prepare("INSERT INTO a(id, k) VALUES (?, ?)");
        const insB = engine.prepare("INSERT INTO b(id, k) VALUES (?, ?)");
        engine.transaction(() => {
          for (let i = 1; i <= 500; i++) {
            insA.run(i, `k${i}`);
            insB.run(i, `k${i}`);
          }
        });
        return engine.prepare("SELECT a.id FROM a JOIN b ON a.k = b.k");
      },
      fn: (_engine, ctx) => {
        (ctx as { all: () => unknown }).all();
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
      setup: (engine) => {
        engine.exec("CREATE TABLE a (id INTEGER PRIMARY KEY, k INTEGER)");
        engine.exec("CREATE TABLE b (id INTEGER PRIMARY KEY, k INTEGER)");
        engine.exec("CREATE INDEX idx_b_k ON b(k)");
        const insA = engine.prepare("INSERT INTO a(id, k) VALUES (?, ?)");
        const insB = engine.prepare("INSERT INTO b(id, k) VALUES (?, ?)");
        engine.transaction(() => {
          for (let i = 1; i <= 500; i++) {
            insA.run(i, i % 7 === 0 ? null : i);
            insB.run(i, i % 11 === 0 ? null : i);
          }
        });
        return engine.prepare("SELECT a.id FROM a LEFT JOIN b ON a.k = b.k");
      },
      fn: (_engine, ctx) => {
        (ctx as { all: () => unknown }).all();
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
      setup: (engine) => {
        engine.exec("CREATE TABLE a (id INTEGER PRIMARY KEY, k INTEGER NOT NULL)");
        engine.exec("CREATE TABLE b (id INTEGER PRIMARY KEY, k INTEGER NOT NULL)");
        const insA = engine.prepare("INSERT INTO a(id, k) VALUES (?, ?)");
        const insB = engine.prepare("INSERT INTO b(id, k) VALUES (?, ?)");
        engine.transaction(() => {
          for (let i = 1; i <= 500; i++) {
            insA.run(i, i);
            insB.run(i, i);
          }
        });
        return engine.prepare("SELECT a.id FROM a JOIN b ON a.k = b.k");
      },
      fn: (_engine, ctx) => {
        (ctx as { all: () => unknown }).all();
      },
    }),
    spec({
      name: "join/nested-loop/200",
      operation: "non-equality nested loop join",
      datasetSize: 200,
      tiers: ["default", "full"],
      layer: "engine",
      warmup: 1,
      iterations: 4,
      setup: (engine) => {
        engine.exec("CREATE TABLE a (id INTEGER PRIMARY KEY, k INTEGER NOT NULL)");
        engine.exec("CREATE TABLE b (id INTEGER PRIMARY KEY, k INTEGER NOT NULL)");
        const insA = engine.prepare("INSERT INTO a(id, k) VALUES (?, ?)");
        const insB = engine.prepare("INSERT INTO b(id, k) VALUES (?, ?)");
        engine.transaction(() => {
          for (let i = 1; i <= 200; i++) {
            insA.run(i, i);
            insB.run(i, i);
          }
        });
        return engine.prepare("SELECT a.id FROM a JOIN b ON a.k < b.k AND b.k < a.k + 3");
      },
      fn: (_engine, ctx) => {
        (ctx as { all: () => unknown }).all();
      },
    }),
  ];
}

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
      fn: (engine) => {
        engine.exec("DROP TABLE IF EXISTS t");
        engine.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
        engine.exec("INSERT INTO t(name) VALUES ('a')");
        engine.query("SELECT id, name FROM t");
      },
    }),
  ];
}
