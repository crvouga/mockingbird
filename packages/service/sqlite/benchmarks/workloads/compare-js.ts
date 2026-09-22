import type { BenchEngine, BenchSpec, BenchStatement } from "../harness/types.ts";
import { spec } from "./tiers.ts";

const SIZES = [
  { n: 100, tiers: ["ci", "default", "full"] as BenchSpec["tiers"] },
  { n: 1000, tiers: ["ci", "default", "full"] as BenchSpec["tiers"] },
];

async function awaitMaybe<T>(value: T | Promise<T>): Promise<T> {
  return await value;
}

async function prepare(engine: BenchEngine, sql: string): Promise<BenchStatement> {
  return await awaitMaybe(engine.prepare(sql));
}

async function exec(engine: BenchEngine, sql: string, params: unknown[] = []): Promise<void> {
  await awaitMaybe(engine.exec(sql, params));
}

async function tx<T>(engine: BenchEngine, fn: () => Promise<T>): Promise<T> {
  // Avoid sync transaction wrappers that commit before async work finishes.
  const begin = engine.name === "alasql" ? "BEGIN TRANSACTION" : "BEGIN";
  const commit = engine.name === "alasql" ? "COMMIT TRANSACTION" : "COMMIT";
  const rollback = engine.name === "alasql" ? "ROLLBACK TRANSACTION" : "ROLLBACK";
  await exec(engine, begin);
  try {
    const value = await fn();
    await exec(engine, commit);
    return value;
  } catch (error) {
    try {
      await exec(engine, rollback);
    } catch {
      // ignore
    }
    throw error;
  }
}

async function stmtRun(stmt: BenchStatement, ...params: unknown[]): Promise<void> {
  await awaitMaybe(stmt.run(...params));
}

async function stmtGet(stmt: BenchStatement, ...params: unknown[]): Promise<unknown> {
  return await awaitMaybe(stmt.get(...params));
}

async function stmtAll(stmt: BenchStatement, ...params: unknown[]): Promise<unknown> {
  return await awaitMaybe(stmt.all(...params));
}

function coreOps(options: {
  prefix: string;
  engines: BenchSpec["engines"];
  createUsers: (engine: BenchEngine) => Promise<void>;
  fillUsers: (engine: BenchEngine, n: number) => Promise<void>;
  createJoin: (engine: BenchEngine, n: number) => Promise<BenchStatement>;
  insertSql: string;
  lookupSql: string;
}): BenchSpec[] {
  const specs: BenchSpec[] = [];
  for (const { n, tiers } of SIZES) {
    const iterations = n >= 1000 ? 8 : 12;
    const warmup = 1;

    specs.push(
      spec({
        name: `${options.prefix}/pk-lookup/${n}`,
        operation: "id equality lookup",
        datasetSize: n,
        tiers,
        engines: options.engines,
        layer: "engine",
        warmup,
        iterations,
        opsPerSample: 10,
        setup: async (engine) => {
          await options.fillUsers(engine, n);
          return {
            stmt: await prepare(engine, options.lookupSql),
            id: Math.max(1, Math.floor(n / 2)),
          };
        },
        fn: async (_engine, ctx) => {
          const { stmt, id } = ctx as { stmt: BenchStatement; id: number };
          for (let i = 0; i < 10; i++) await stmtGet(stmt, id);
        },
      }),
      spec({
        name: `${options.prefix}/insert/${n}`,
        operation: "N inserts",
        datasetSize: n,
        tiers,
        engines: options.engines,
        layer: "engine",
        isolateIterations: true,
        warmup: 0,
        iterations: n >= 1000 ? 3 : 5,
        opsPerSample: n,
        setup: async (engine) => {
          await options.createUsers(engine);
          return prepare(engine, options.insertSql);
        },
        fn: async (engine, ctx) => {
          const stmt = ctx as BenchStatement;
          await tx(engine, async () => {
            for (let i = 1; i <= n; i++) {
              await stmtRun(stmt, i, `u${i}@ex.test`, `User ${i}`, 1_700_000_000 + i);
            }
          });
        },
      }),
      spec({
        name: `${options.prefix}/join/${n}`,
        operation: "equality join",
        datasetSize: n,
        tiers,
        engines: options.engines,
        layer: "engine",
        warmup,
        iterations,
        setup: (engine) => options.createJoin(engine, n),
        fn: async (_engine, ctx) => {
          await stmtAll(ctx as BenchStatement);
        },
      }),
      spec({
        name: `${options.prefix}/prepared-execute/${n}`,
        operation: "prepared id lookups",
        datasetSize: n,
        tiers,
        engines: options.engines,
        layer: "engine",
        warmup,
        iterations,
        opsPerSample: Math.min(n, 1000),
        setup: async (engine) => {
          await options.fillUsers(engine, Math.min(n, 1000));
          return prepare(engine, options.lookupSql);
        },
        fn: async (_engine, ctx) => {
          const stmt = ctx as BenchStatement;
          const limit = Math.min(n, 1000);
          for (let i = 1; i <= limit; i++) await stmtGet(stmt, ((i - 1) % limit) + 1);
        },
      }),
    );
  }
  return specs;
}

/** Dialect-safe track: sqlite-mem vs AlaSQL (no INTEGER PRIMARY KEY). */
export function compareJsSpecs(): BenchSpec[] {
  const createUsers = async (engine: BenchEngine) => {
    await exec(engine, "CREATE TABLE users (id INT, email STRING, name STRING, created_at INT)");
  };
  const fillUsers = async (engine: BenchEngine, n: number) => {
    await createUsers(engine);
    const ins = await prepare(engine, "INSERT INTO users VALUES (?,?,?,?)");
    await tx(engine, async () => {
      for (let i = 1; i <= n; i++) {
        await stmtRun(ins, i, `u${i}@ex.test`, `User ${i}`, 1_700_000_000 + i);
      }
    });
  };
  const createJoin = async (engine: BenchEngine, n: number) => {
    await exec(engine, "CREATE TABLE small (id INT, k INT)");
    await exec(engine, "CREATE TABLE large (id INT, k INT, label STRING)");
    const insS = await prepare(engine, "INSERT INTO small VALUES (?,?)");
    const insL = await prepare(engine, "INSERT INTO large VALUES (?,?,?)");
    await tx(engine, async () => {
      const smallN = Math.min(20, n);
      for (let i = 1; i <= smallN; i++) await stmtRun(insS, i, i);
      for (let i = 1; i <= n; i++) await stmtRun(insL, i, i, `L${i}`);
    });
    return prepare(engine, "SELECT small.id, large.label FROM small JOIN large ON large.k = small.k");
  };

  return coreOps({
    prefix: "compare/js",
    engines: "compare-js",
    createUsers,
    fillUsers,
    createJoin,
    insertSql: "INSERT INTO users VALUES (?,?,?,?)",
    lookupSql: "SELECT id, name FROM users WHERE id = ?",
  });
}

/** SQLite-native track: INTEGER PRIMARY KEY for sqlite-mem / bun:sqlite / sql.js / wa-sqlite. */
export function compareSqliteSpecs(): BenchSpec[] {
  const createUsers = async (engine: BenchEngine) => {
    await exec(
      engine,
      "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL)",
    );
  };
  const fillUsers = async (engine: BenchEngine, n: number) => {
    await createUsers(engine);
    const ins = await prepare(engine, "INSERT INTO users(id, email, name, created_at) VALUES (?,?,?,?)");
    await tx(engine, async () => {
      for (let i = 1; i <= n; i++) {
        await stmtRun(ins, i, `u${i}@ex.test`, `User ${i}`, 1_700_000_000 + i);
      }
    });
  };
  const createJoin = async (engine: BenchEngine, n: number) => {
    await exec(engine, "CREATE TABLE small (id INTEGER PRIMARY KEY, k INTEGER NOT NULL)");
    await exec(engine, "CREATE TABLE large (id INTEGER PRIMARY KEY, k INTEGER NOT NULL, label TEXT)");
    await exec(engine, "CREATE INDEX idx_large_k ON large(k)");
    const insS = await prepare(engine, "INSERT INTO small(id, k) VALUES (?,?)");
    const insL = await prepare(engine, "INSERT INTO large(id, k, label) VALUES (?,?,?)");
    await tx(engine, async () => {
      const smallN = Math.min(20, n);
      for (let i = 1; i <= smallN; i++) await stmtRun(insS, i, i);
      for (let i = 1; i <= n; i++) await stmtRun(insL, i, i, `L${i}`);
    });
    return prepare(engine, "SELECT small.id, large.label FROM small JOIN large ON large.k = small.k");
  };

  const sqliteCore = coreOps({
    prefix: "compare/sqlite",
    engines: "compare-sqlite",
    createUsers,
    fillUsers,
    createJoin,
    insertSql: "INSERT INTO users(id, email, name, created_at) VALUES (?,?,?,?)",
    lookupSql: "SELECT id, name FROM users WHERE id = ?",
  });

  const extra: BenchSpec[] = [];
  for (const { n, tiers } of SIZES) {
    extra.push(
      spec({
        name: `compare/sqlite/range-gt/${n}`,
        operation: "indexed created_at > ?",
        datasetSize: n,
        tiers,
        engines: "compare-sqlite",
        layer: "engine",
        warmup: 1,
        iterations: n >= 1000 ? 8 : 12,
        setup: async (engine) => {
          await fillUsers(engine, n);
          await exec(engine, "CREATE INDEX idx_users_created ON users(created_at)");
          return prepare(engine, "SELECT id FROM users WHERE created_at > ?");
        },
        fn: async (_engine, ctx) => {
          await stmtAll(ctx as BenchStatement, 1_700_000_000 + Math.floor(n * 0.8));
        },
      }),
      spec({
        name: `compare/sqlite/index-prefix/${n}`,
        operation: "composite index prefix",
        datasetSize: n,
        tiers,
        engines: "compare-sqlite",
        layer: "engine",
        warmup: 1,
        iterations: n >= 1000 ? 8 : 12,
        setup: async (engine) => {
          await exec(engine, "CREATE TABLE events (id INTEGER PRIMARY KEY, a INTEGER NOT NULL, b INTEGER NOT NULL)");
          await exec(engine, "CREATE INDEX idx_events_ab ON events(a, b)");
          const ins = await prepare(engine, "INSERT INTO events(id, a, b) VALUES (?,?,?)");
          await tx(engine, async () => {
            for (let i = 1; i <= n; i++) await stmtRun(ins, i, Math.floor(i / 10), i % 10);
          });
          return prepare(engine, "SELECT id FROM events WHERE a = ?");
        },
        fn: async (_engine, ctx) => {
          await stmtAll(ctx as BenchStatement, Math.floor(n / 20));
        },
      }),
    );
  }

  return [...sqliteCore, ...extra];
}

/** Both comparison tracks. */
export function compareAllSpecs(): BenchSpec[] {
  return [...compareJsSpecs(), ...compareSqliteSpecs()];
}
