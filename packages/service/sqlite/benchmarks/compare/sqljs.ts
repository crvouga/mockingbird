import initSqlJs from "sql.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchEngine, BenchStatement, NamedFactory } from "../harness/types.ts";

type SqlJsDatabase = {
  run: (sql: string, params?: unknown[]) => void;
  exec: (sql: string) => { columns: string[]; values: unknown[][] }[];
  prepare: (sql: string) => SqlJsStatement;
  export: () => Uint8Array;
  close: () => void;
};

type SqlJsStatement = {
  run: (params?: unknown[]) => void;
  bind: (params: unknown[]) => boolean;
  step: () => boolean;
  getAsObject: () => Record<string, unknown>;
  reset: () => void;
  free: () => void;
};

type SqlJsStatic = {
  Database: new (data?: ArrayLike<number> | null) => SqlJsDatabase;
};

let sqlModule: SqlJsStatic | null = null;

async function loadSqlJs(): Promise<SqlJsStatic> {
  if (sqlModule) return sqlModule;
  const wasmDir = path.dirname(fileURLToPath(import.meta.resolve("sql.js/dist/sql-wasm.js")));
  sqlModule = (await initSqlJs({
    locateFile: (file: string) => path.join(wasmDir, file),
  })) as unknown as SqlJsStatic;
  return sqlModule;
}

function wrapStatement(stmt: SqlJsStatement): BenchStatement {
  return {
    run: (...params: unknown[]) => {
      if (params.length) stmt.run(params);
      else stmt.run();
      return { changes: 0, lastInsertRowid: 0 };
    },
    all: <T = Record<string, unknown>>(...params: unknown[]) => {
      stmt.reset();
      if (params.length) stmt.bind(params);
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as T);
      stmt.reset();
      return rows;
    },
    get: <T = Record<string, unknown>>(...params: unknown[]) => {
      stmt.reset();
      if (params.length) stmt.bind(params);
      const row = stmt.step() ? (stmt.getAsObject() as T) : undefined;
      stmt.reset();
      return row;
    },
  };
}

function createEngine(SQL: SqlJsStatic, initial?: Uint8Array): BenchEngine {
  let db: SqlJsDatabase = initial ? new SQL.Database(initial) : new SQL.Database();
  const statements = new Set<SqlJsStatement>();

  return {
    name: "sql.js",
    exec: (sql, params = []) => {
      if (params.length === 0) db.run(sql);
      else db.run(sql, params);
    },
    query: <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
      const stmt = db.prepare(sql);
      try {
        if (params.length) stmt.bind(params);
        const rows: T[] = [];
        while (stmt.step()) rows.push(stmt.getAsObject() as T);
        return rows;
      } finally {
        stmt.free();
      }
    },
    prepare: (sql) => {
      const stmt = db.prepare(sql);
      statements.add(stmt);
      return wrapStatement(stmt);
    },
    transaction: (fn) => {
      db.run("BEGIN");
      try {
        const value = fn();
        db.run("COMMIT");
        return value;
      } catch (error) {
        try {
          db.run("ROLLBACK");
        } catch {
          // ignore
        }
        throw error;
      }
    },
    snapshot: () => db.export(),
    restore: (bytes) => {
      for (const stmt of statements) {
        try {
          stmt.free();
        } catch {
          // ignore
        }
      }
      statements.clear();
      db.close();
      db = new SQL.Database(bytes);
    },
    close: () => {
      for (const stmt of statements) {
        try {
          stmt.free();
        } catch {
          // ignore
        }
      }
      statements.clear();
      try {
        db.close();
      } catch {
        // ignore
      }
    },
  };
}

export async function tryLoadSqlJsFactory(): Promise<NamedFactory | null> {
  try {
    const SQL = await loadSqlJs();
    return {
      name: "sql.js",
      create: () => createEngine(SQL),
    };
  } catch (error) {
    console.warn(`sql.js unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
