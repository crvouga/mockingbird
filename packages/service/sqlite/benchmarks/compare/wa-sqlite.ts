import type { BenchEngine, BenchStatement, NamedFactory } from "../harness/types.ts";

type SqliteApi = {
  open_v2: (filename: string, flags?: number, vfs?: string) => Promise<number>;
  close: (db: number) => Promise<number>;
  exec: (db: number, sql: string) => Promise<void>;
  prepare_v2: (db: number, sql: number) => Promise<{ stmt: number; sql: number } | null>;
  bind_collection: (stmt: number, values: unknown[]) => number;
  step: (stmt: number) => Promise<number>;
  reset: (stmt: number) => Promise<number>;
  finalize: (stmt: number) => Promise<number>;
  column_count: (stmt: number) => number;
  column_name: (stmt: number, i: number) => string;
  column: (stmt: number, i: number) => unknown;
  row: (stmt: number) => unknown[];
  str_new: (db: number, s: string) => number;
  str_value: (str: number) => number;
  str_finish: (str: number) => void;
  changes: (db: number) => number;
};

type WaModule = {
  SQLITE_ROW: number;
  SQLITE_DONE: number;
  Factory: (module: unknown) => SqliteApi;
};

type WaState = {
  sqlite3: SqliteApi;
  SQLITE_ROW: number;
  SQLITE_DONE: number;
};

let shared: WaState | null = null;

async function loadWaSqlite(): Promise<WaState> {
  if (shared) return shared;
  const SQLiteESMFactory = (await import("wa-sqlite/dist/wa-sqlite.mjs")).default;
  const SQLite = (await import("wa-sqlite")) as unknown as WaModule;
  const module = await SQLiteESMFactory();
  const sqlite3 = SQLite.Factory(module);
  shared = { sqlite3, SQLITE_ROW: SQLite.SQLITE_ROW, SQLITE_DONE: SQLite.SQLITE_DONE };
  return shared;
}

async function prepareStmt(sqlite3: SqliteApi, db: number, sql: string): Promise<number> {
  const str = sqlite3.str_new(db, sql);
  try {
    const prepared = await sqlite3.prepare_v2(db, sqlite3.str_value(str));
    if (!prepared?.stmt) throw new Error(`wa-sqlite prepare failed: ${sql}`);
    return prepared.stmt;
  } finally {
    sqlite3.str_finish(str);
  }
}

function rowObject(sqlite3: SqliteApi, stmt: number): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  const n = sqlite3.column_count(stmt);
  for (let i = 0; i < n; i++) {
    row[sqlite3.column_name(stmt, i)] = sqlite3.column(stmt, i);
  }
  return row;
}

function wrapStatement(sqlite3: SqliteApi, db: number, stmt: number, constants: WaState): BenchStatement {
  return {
    run: async (...params: unknown[]) => {
      await sqlite3.reset(stmt);
      if (params.length) sqlite3.bind_collection(stmt, params);
      await sqlite3.step(stmt);
      await sqlite3.reset(stmt);
      return {
        changes: sqlite3.changes(db),
        lastInsertRowid: 0,
      };
    },
    all: async <T = Record<string, unknown>>(...params: unknown[]) => {
      await sqlite3.reset(stmt);
      if (params.length) sqlite3.bind_collection(stmt, params);
      const rows: T[] = [];
      while ((await sqlite3.step(stmt)) === constants.SQLITE_ROW) {
        rows.push(rowObject(sqlite3, stmt) as T);
      }
      await sqlite3.reset(stmt);
      return rows;
    },
    get: async <T = Record<string, unknown>>(...params: unknown[]) => {
      await sqlite3.reset(stmt);
      if (params.length) sqlite3.bind_collection(stmt, params);
      const rc = await sqlite3.step(stmt);
      const row = rc === constants.SQLITE_ROW ? (rowObject(sqlite3, stmt) as T) : undefined;
      await sqlite3.reset(stmt);
      return row;
    },
  };
}

async function createWaSqliteEngine(): Promise<BenchEngine> {
  const state = await loadWaSqlite();
  const { sqlite3 } = state;
  const db = await sqlite3.open_v2(":memory:");
  const liveStmts = new Set<number>();

  return {
    name: "wa-sqlite",
    exec: async (sql, params = []) => {
      if (params.length === 0) {
        await sqlite3.exec(db, sql);
        return;
      }
      const stmt = await prepareStmt(sqlite3, db, sql);
      try {
        sqlite3.bind_collection(stmt, params);
        await sqlite3.step(stmt);
      } finally {
        await sqlite3.finalize(stmt);
      }
    },
    query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
      const stmt = await prepareStmt(sqlite3, db, sql);
      try {
        if (params.length) sqlite3.bind_collection(stmt, params);
        const rows: T[] = [];
        while ((await sqlite3.step(stmt)) === state.SQLITE_ROW) {
          rows.push(rowObject(sqlite3, stmt) as T);
        }
        return rows;
      } finally {
        await sqlite3.finalize(stmt);
      }
    },
    prepare: async (sql) => {
      const stmt = await prepareStmt(sqlite3, db, sql);
      liveStmts.add(stmt);
      return wrapStatement(sqlite3, db, stmt, state);
    },
    transaction: async (fn) => {
      await sqlite3.exec(db, "BEGIN");
      try {
        const value = await fn();
        await sqlite3.exec(db, "COMMIT");
        return value;
      } catch (error) {
        try {
          await sqlite3.exec(db, "ROLLBACK");
        } catch {
          // ignore
        }
        throw error;
      }
    },
    snapshot: () => {
      throw new Error("wa-sqlite adapter does not support snapshot()");
    },
    restore: () => {
      throw new Error("wa-sqlite adapter does not support restore()");
    },
    close: async () => {
      for (const stmt of liveStmts) {
        try {
          await sqlite3.finalize(stmt);
        } catch {
          // ignore
        }
      }
      liveStmts.clear();
      try {
        await sqlite3.close(db);
      } catch {
        // ignore
      }
    },
  };
}

export async function tryLoadWaSqliteFactory(): Promise<NamedFactory | null> {
  try {
    await loadWaSqlite();
    return {
      name: "wa-sqlite",
      create: () => createWaSqliteEngine(),
    };
  } catch (error) {
    console.warn(`wa-sqlite unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
