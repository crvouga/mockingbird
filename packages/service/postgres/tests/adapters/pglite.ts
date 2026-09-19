import { PGlite } from "@electric-sql/pglite";
import { categoryFromSqlstate } from "../harness/classify.ts";
import { normalizeErrorMessage } from "../harness/normalize.ts";
import { applyTxnSql, failResult, okResult } from "../harness/session.ts";
import type { CellValue, ContractDb, ContractStatement, QueryResult, SqlValue } from "../harness/types.ts";

/**
 * Real-Postgres oracle backed by PGlite (Postgres 18.x compiled to WASM,
 * in-process). Results are captured as raw server text via identity parsers
 * for every pg_type OID, so comparison happens on canonical Postgres output.
 *
 * A single PGlite instance is shared across tests (instances are expensive);
 * `PgliteAdapter` resets it to a pristine state on construction.
 */

let shared: Promise<{ db: PGlite; parsers: Record<number, (x: string) => string> }> | null = null;

async function getShared(): Promise<{ db: PGlite; parsers: Record<number, (x: string) => string> }> {
  if (!shared) {
    shared = (async () => {
      const db = new PGlite();
      await db.waitReady;
      // PGlite's WASM boot leaks process.exitCode = 99 (electric-sql/pglite#975);
      // clear it so a green `bun test` run exits 0. Bun ignores `= undefined`.
      process.exitCode = 0;
      const res = await db.query<{ oid: number }>("SELECT oid FROM pg_type");
      const parsers: Record<number, (x: string) => string> = {};
      for (const row of res.rows) parsers[Number(row.oid)] = (x) => x;
      return { db, parsers };
    })();
  }
  return shared;
}

/** Drop all user objects and reset session state. */
async function resetOracle(db: PGlite): Promise<void> {
  try {
    await db.query("ROLLBACK");
  } catch {
    // not in a transaction
  }
  await db.exec(`
    DO $$
    DECLARE s text;
    BEGIN
      FOR s IN
        SELECT nspname FROM pg_namespace
        WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          AND nspname NOT LIKE 'pg_temp%'
          AND nspname NOT LIKE 'pg_toast_temp%'
      LOOP
        EXECUTE format('DROP SCHEMA %I CASCADE', s);
      END LOOP;
    END $$;
    CREATE SCHEMA public;
    DEALLOCATE ALL;
    RESET ALL;
    SET TIME ZONE 'UTC';
    SET datestyle TO 'ISO, MDY';
    SET intervalstyle TO 'postgres';
    SET extra_float_digits TO 1;
  `);
}

function toCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  return String(value);
}

interface PgliteError {
  code?: string;
  message?: string;
}

export class PgliteAdapter implements ContractDb {
  private ready: Promise<{ db: PGlite; parsers: Record<number, (x: string) => string> }>;
  private inTxn = false;
  private closed = false;

  constructor() {
    this.ready = getShared().then(async (s) => {
      await resetOracle(s.db);
      return s;
    });
  }

  async exec(sql: string, params?: SqlValue[]): Promise<QueryResult> {
    return this.runSql(sql, params, false);
  }

  async query(sql: string, params?: SqlValue[]): Promise<QueryResult> {
    return this.runSql(sql, params, true);
  }

  prepare(sql: string): ContractStatement {
    return {
      run: (...params: SqlValue[]) => this.runSql(sql, params, false),
      all: (...params: SqlValue[]) => this.runSql(sql, params, true),
      get: async (...params: SqlValue[]) => {
        const res = await this.runSql(sql, params, true);
        if (!res.ok) return res;
        return { ...res, rows: res.rows.slice(0, 1), values: res.values.slice(0, 1) };
      },
    };
  }

  snapshot(): Uint8Array {
    throw new Error("PGlite oracle does not participate in snapshot tests");
  }

  restore(_bytes: Uint8Array): void {
    throw new Error("PGlite oracle does not participate in snapshot tests");
  }

  async close(): Promise<void> {
    // shared instance stays alive; roll back any open transaction
    if (this.closed) return;
    this.closed = true;
    const { db } = await this.ready;
    if (this.inTxn) {
      try {
        await db.query("ROLLBACK");
      } catch {
        // already aborted
      }
      this.inTxn = false;
    }
  }

  inTransaction(): boolean {
    return this.inTxn;
  }

  private async runSql(sql: string, params: SqlValue[] | undefined, _isQuery: boolean): Promise<QueryResult> {
    const { db, parsers } = await this.ready;
    try {
      if (!params || params.length === 0) {
        // exec path: allow multi-statement scripts; capture the last result
        const results = await db.exec(sql, { parsers, rowMode: "array" } as Parameters<PGlite["exec"]>[1]);
        this.inTxn = applyTxnSqlScript(sql, this.inTxn);
        const last = results[results.length - 1];
        if (!last) return okResult([], [], 0, undefined, this.inTxn);
        const columns = last.fields.map((f) => f.name);
        const values = (last.rows as unknown as unknown[][]).map((row) => row.map(toCell));
        return okResult(columns, values, last.affectedRows ?? 0, last.command, this.inTxn);
      }
      const res = await db.query(sql, toParams(params), { parsers, rowMode: "array" } as Parameters<
        PGlite["query"]
      >[2]);
      this.inTxn = applyTxnSql(sql, this.inTxn);
      const columns = res.fields.map((f) => f.name);
      const values = (res.rows as unknown as unknown[][]).map((row) => row.map(toCell));
      return okResult(columns, values, res.affectedRows ?? 0, res.command, this.inTxn);
    } catch (error) {
      const e = error as PgliteError;
      const message = normalizeErrorMessage(e.message ?? String(error));
      const sqlstate = typeof e.code === "string" && e.code.length === 5 ? e.code : undefined;
      // a failed statement aborts an open oracle transaction only logically; state tracked as-is
      return failResult(
        {
          category: categoryFromSqlstate(sqlstate),
          message,
          ...(sqlstate ? { sqlstate } : {}),
        },
        this.inTxn,
        "step",
      );
    }
  }
}

function toParams(params: SqlValue[]): unknown[] {
  return params.map((p) => (typeof p === "bigint" ? p.toString() : p));
}

function applyTxnSqlScript(sql: string, inTxn: boolean): boolean {
  let txn = inTxn;
  for (const stmt of sql.split(";")) {
    if (stmt.trim().length > 0) txn = applyTxnSql(stmt, txn);
  }
  return txn;
}
