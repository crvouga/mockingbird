import type { BenchSpec } from "../harness/types.ts";
import { insertMany } from "./populate.ts";
import { CI, DEFAULT, FULL, spec } from "./tiers.ts";

function fillEvents(
  engine: {
    exec: (sql: string) => void;
    prepare: (sql: string) => { run: (...a: unknown[]) => unknown };
    transaction: (fn: () => void) => void;
  },
  n: number,
  withIndex: boolean,
): void {
  engine.exec(
    "CREATE TABLE events (id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, kind TEXT NOT NULL, a INTEGER NOT NULL, b INTEGER NOT NULL)",
  );
  if (withIndex) {
    engine.exec("CREATE INDEX idx_events_created ON events(created_at)");
    engine.exec("CREATE INDEX idx_events_ab ON events(a, b)");
  }
  insertMany(engine as never, "INSERT INTO events(id, created_at, kind, a, b) VALUES (?, ?, ?, ?, ?)", n, (i) => [
    i,
    1_700_000_000 + i,
    i % 3 === 0 ? "active" : "idle",
    Math.floor(i / 10),
    i % 10,
  ]);
}

export function hotspotSpecs(): BenchSpec[] {
  const specs: BenchSpec[] = [];

  for (const n of [100, 1000]) {
    const tiers = n <= 100 ? CI : DEFAULT;
    const iterations = n <= 100 ? 12 : 8;
    specs.push(
      spec({
        name: `hotspot/range-gt/${n}`,
        operation: "indexed created_at > ?",
        datasetSize: n,
        tiers,
        warmup: 1,
        iterations,
        setup: (engine) => {
          fillEvents(engine, n, true);
          return engine.prepare("SELECT id FROM events WHERE created_at > ?");
        },
        fn: (_engine, ctx) => {
          (ctx as { all: (v: unknown) => unknown }).all(1_700_000_000 + Math.floor(n * 0.8));
        },
      }),
      spec({
        name: `hotspot/range-gt-scan/${n}`,
        operation: "unindexed created_at > ?",
        datasetSize: n,
        tiers: n <= 100 ? CI : DEFAULT,
        warmup: 1,
        iterations,
        setup: (engine) => {
          fillEvents(engine, n, false);
          return engine.prepare("SELECT id FROM events WHERE created_at > ?");
        },
        fn: (_engine, ctx) => {
          (ctx as { all: (v: unknown) => unknown }).all(1_700_000_000 + Math.floor(n * 0.8));
        },
      }),
      spec({
        name: `hotspot/between/${n}`,
        operation: "indexed BETWEEN",
        datasetSize: n,
        tiers,
        warmup: 1,
        iterations,
        setup: (engine) => {
          fillEvents(engine, n, true);
          const lo = 1_700_000_000 + Math.floor(n * 0.4);
          return { stmt: engine.prepare("SELECT id FROM events WHERE created_at BETWEEN ? AND ?"), lo, hi: lo + 20 };
        },
        fn: (_engine, ctx) => {
          const { stmt, lo, hi } = ctx as { stmt: { all: (...a: unknown[]) => unknown }; lo: number; hi: number };
          stmt.all(lo, hi);
        },
      }),
      spec({
        name: `hotspot/order-limit/${n}`,
        operation: "ORDER BY indexed LIMIT 50",
        datasetSize: n,
        tiers,
        warmup: 1,
        iterations,
        setup: (engine) => {
          fillEvents(engine, n, true);
          return engine.prepare("SELECT id FROM events ORDER BY created_at DESC LIMIT 50");
        },
        fn: (_engine, ctx) => {
          (ctx as { all: () => unknown }).all();
        },
      }),
      spec({
        name: `hotspot/index-prefix/${n}`,
        operation: "composite index leftmost prefix",
        datasetSize: n,
        tiers,
        warmup: 1,
        iterations,
        opsPerSample: 10,
        setup: (engine) => {
          fillEvents(engine, n, true);
          return { stmt: engine.prepare("SELECT id FROM events WHERE a = ?"), a: Math.floor(n / 20) };
        },
        fn: (_engine, ctx) => {
          const { stmt, a } = ctx as { stmt: { all: (v: unknown) => unknown }; a: number };
          for (let i = 0; i < 10; i++) stmt.all(a);
        },
      }),
    );
  }

  specs.push(
    spec({
      name: "hotspot/partial-lookup/1000",
      operation: "partial unique index lookup",
      datasetSize: 1000,
      tiers: CI,
      warmup: 1,
      iterations: 8,
      opsPerSample: 10,
      setup: (engine) => {
        engine.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, email TEXT NOT NULL, active INTEGER NOT NULL)");
        engine.exec("CREATE UNIQUE INDEX t_email_active ON t(email) WHERE active = 1");
        insertMany(engine, "INSERT INTO t(id, email, active) VALUES (?, ?, ?)", 1000, (i) => [
          i,
          `u${i}@ex.test`,
          i % 2,
        ]);
        return engine.prepare("SELECT id FROM t WHERE email = ? AND active = 1");
      },
      fn: (_engine, ctx) => {
        const stmt = ctx as { get: (e: string) => unknown };
        for (let i = 0; i < 10; i++) stmt.get(`u${100 + i * 2}@ex.test`);
      },
    }),
    spec({
      name: "hotspot/tx-begin/1000",
      operation: "BEGIN on 1000-row DB",
      datasetSize: 1000,
      tiers: CI,
      warmup: 1,
      iterations: 12,
      setup: (engine) => fillEvents(engine, 1000, true),
      fn: (engine) => {
        engine.exec("BEGIN");
        engine.exec("ROLLBACK");
      },
    }),
    spec({
      name: "hotspot/tx-begin/10000",
      operation: "BEGIN on 10000-row DB",
      datasetSize: 10_000,
      tiers: FULL,
      warmup: 0,
      iterations: 6,
      setup: (engine) => fillEvents(engine, 10_000, true),
      fn: (engine) => {
        engine.exec("BEGIN");
        engine.exec("ROLLBACK");
      },
    }),
    spec({
      name: "hotspot/savepoint/1000",
      operation: "SAVEPOINT on 1000-row DB",
      datasetSize: 1000,
      tiers: CI,
      warmup: 1,
      iterations: 8,
      setup: (engine) => {
        fillEvents(engine, 1000, true);
        engine.exec("BEGIN");
      },
      fn: (engine) => {
        engine.exec("SAVEPOINT s1");
        engine.exec("RELEASE s1");
      },
    }),
    spec({
      name: "hotspot/insert-pk/1000",
      operation: "1000 INTEGER PK inserts with secondary index",
      datasetSize: 1000,
      tiers: CI,
      isolateIterations: true,
      warmup: 0,
      iterations: 3,
      opsPerSample: 1000,
      setup: (engine) => {
        engine.exec(
          "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL)",
        );
        engine.exec("CREATE INDEX idx_users_email ON users(email)");
        return engine.prepare("INSERT INTO users(id, email, name, created_at) VALUES (?, ?, ?, ?)");
      },
      fn: (engine, ctx) => {
        const stmt = ctx as { run: (...a: unknown[]) => unknown };
        engine.transaction(() => {
          for (let i = 1; i <= 1000; i++) stmt.run(i, `u${i}@ex.test`, `User ${i}`, 1_700_000_000 + i);
        });
      },
    }),
  );

  return specs;
}
