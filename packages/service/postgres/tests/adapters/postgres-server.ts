import pg from "pg";
import { categoryFromSqlstate } from "../harness/classify.ts";
import { normalizeErrorMessage } from "../harness/normalize.ts";
import { applyTxnSql, failResult, okResult } from "../harness/session.ts";
import type { CellValue, ContractDb, ContractStatement, QueryResult, SqlValue } from "../harness/types.ts";

/**
 * Real-Postgres oracle backed by a TCP PostgreSQL server (`pg` client).
 * Selected when `POSTGRES_MEM_ORACLE=server` (see `tests/harness/oracle.ts`).
 *
 * Cells stay as raw server text via identity type parsers + array row mode,
 * matching the PGlite adapter's comparison surface.
 *
 * One shared connection is reused; each adapter construction resets schemas /
 * session GUCs. Operations are serialized so parallel Bun test files cannot
 * race the shared session.
 */

const RESET_SQL = `
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
GRANT ALL ON SCHEMA public TO PUBLIC;
GRANT ALL ON SCHEMA public TO CURRENT_USER;
DEALLOCATE ALL;
RESET ALL;
SET TIME ZONE 'UTC';
SET datestyle TO 'ISO, MDY';
SET intervalstyle TO 'postgres';
SET extra_float_digits TO 1;
`;

const textTypes: pg.CustomTypesConfig = {
  getTypeParser: () => (value: string) => value,
};

let shared: Promise<pg.Client> | null = null;
let chain: Promise<unknown> = Promise.resolve();

function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function connectionString(): string {
  const url = process.env.POSTGRES_MEM_ORACLE_URL;
  if (!url || url.length === 0) {
    throw new Error(
      "POSTGRES_MEM_ORACLE=server requires POSTGRES_MEM_ORACLE_URL " +
        "(set by `bun run test:postgres-native`, or point at Docker / a local server)",
    );
  }
  return url;
}

async function getShared(): Promise<pg.Client> {
  if (!shared) {
    shared = (async () => {
      // Pin database TimeZone so RESET timezone → UTC (matches PGlite / our mem default).
      const bootstrap = new pg.Client({
        connectionString: connectionString(),
        types: textTypes,
      });
      await bootstrap.connect();
      try {
        await bootstrap.query(`
          DO $pin$
          BEGIN
            EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC');
          END
          $pin$;
        `);
      } finally {
        await bootstrap.end();
      }

      const client = new pg.Client({
        connectionString: connectionString(),
        types: textTypes,
      });
      await client.connect();
      // Swallow late FATAL on stop so Bun doesn't treat it as an unhandled rejection.
      client.on("error", () => undefined);
      await client.query("SET TIME ZONE 'UTC'");
      return client;
    })();
  }
  return shared;
}

async function resetOracle(client: pg.Client): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // not in a transaction
  }
  await client.query(RESET_SQL);
}

function toCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  return String(value);
}

function toParams(params: SqlValue[]): unknown[] {
  return params.map((p) => {
    if (typeof p === "bigint") return p.toString();
    if (p instanceof Uint8Array) return Buffer.from(p);
    return p;
  });
}

interface PgError {
  code?: string;
  message?: string;
}

function commandTag(result: pg.QueryResult): string | undefined {
  const tag = result.command;
  return typeof tag === "string" && tag.length > 0 ? tag : undefined;
}

/** node-pg returns `QueryResult | QueryResult[]` for multi-statement simple queries. */
function lastPgResult(result: pg.QueryResult | pg.QueryResult[]): pg.QueryResult {
  if (Array.isArray(result)) {
    const last = result[result.length - 1];
    if (!last) {
      return { command: undefined, rowCount: 0, oid: null, rows: [], fields: [] } as unknown as pg.QueryResult;
    }
    return last;
  }
  return result;
}

function fromPgResult(result: pg.QueryResult | pg.QueryResult[], inTxn: boolean): QueryResult {
  const last = lastPgResult(result);
  const fields = last.fields ?? [];
  const columns = fields.map((f) => f.name);
  const rawRows = (last.rows ?? []) as unknown as unknown[][];
  const values = rawRows.map((row) => {
    if (Array.isArray(row)) return row.map(toCell);
    return columns.map((c) => toCell((row as Record<string, unknown>)[c]));
  });
  return okResult(columns, values, last.rowCount ?? 0, commandTag(last), inTxn);
}

function applyTxnSqlScript(sql: string, inTxn: boolean): boolean {
  let txn = inTxn;
  for (const stmt of sql.split(";")) {
    if (stmt.trim().length > 0) txn = applyTxnSql(stmt, txn);
  }
  return txn;
}

export class PostgresServerAdapter implements ContractDb {
  private ready: Promise<pg.Client>;
  private inTxn = false;
  private closed = false;

  constructor() {
    this.ready = exclusive(async () => {
      const client = await getShared();
      await resetOracle(client);
      return client;
    });
  }

  async exec(sql: string, params?: SqlValue[]): Promise<QueryResult> {
    return this.runSql(sql, params);
  }

  async query(sql: string, params?: SqlValue[]): Promise<QueryResult> {
    return this.runSql(sql, params);
  }

  prepare(sql: string): ContractStatement {
    return {
      run: (...params: SqlValue[]) => this.runSql(sql, params),
      all: (...params: SqlValue[]) => this.runSql(sql, params),
      get: async (...params: SqlValue[]) => {
        const res = await this.runSql(sql, params);
        if (!res.ok) return res;
        return { ...res, rows: res.rows.slice(0, 1), values: res.values.slice(0, 1) };
      },
    };
  }

  snapshot(): Uint8Array {
    throw new Error("Postgres server oracle does not participate in snapshot tests");
  }

  restore(_bytes: Uint8Array): void {
    throw new Error("Postgres server oracle does not participate in snapshot tests");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await exclusive(async () => {
      const client = await this.ready;
      if (this.inTxn) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // already aborted
        }
        this.inTxn = false;
      }
    });
  }

  inTransaction(): boolean {
    return this.inTxn;
  }

  private async runSql(sql: string, params: SqlValue[] | undefined): Promise<QueryResult> {
    return exclusive(async () => {
      const client = await this.ready;
      try {
        if (!params || params.length === 0) {
          // Simple-query path: multi-statement scripts; node-pg returns the last result.
          const result = await client.query({
            text: sql,
            rowMode: "array",
            types: textTypes,
          });
          this.inTxn = applyTxnSqlScript(sql, this.inTxn);
          return fromPgResult(result, this.inTxn);
        }
        const result = await client.query({
          text: sql,
          values: toParams(params),
          rowMode: "array",
          types: textTypes,
        });
        this.inTxn = applyTxnSql(sql, this.inTxn);
        return fromPgResult(result, this.inTxn);
      } catch (error) {
        const e = error as PgError;
        const message = normalizeErrorMessage(e.message ?? String(error));
        const sqlstate = typeof e.code === "string" && e.code.length === 5 ? e.code : undefined;
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
    });
  }
}

/** Drop the shared client so the next adapter reconnects (e.g. after URL change). */
export async function resetPostgresServerShared(): Promise<void> {
  await exclusive(async () => {
    if (!shared) return;
    const client = await shared;
    shared = null;
    try {
      await client.end();
    } catch {
      // ignore
    }
  });
}
