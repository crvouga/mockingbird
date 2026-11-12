/**
 * The shared mock admin API in front of an in-memory PostgreSQL database.
 * `GET /__admin/ui` is the shell; `GET /sql/tables` and `POST /sql/query` feed the explorer.
 *
 * @module
 */
import {
  createEngineAdmin,
  type EngineAdmin,
  type SqlCheckpoint,
  type SqlEngine,
  type SqlPage,
  type SqlResult,
  type SqlTable,
} from "@crvouga/mockingbird-service/admin";
import type { BindValue } from "./api/bind.ts";
import { Database, type DatabaseOptions, type HistoryCheckpoint } from "./api/database.ts";

export interface AdminOptions {
  /** Database for the `default` namespace. Other namespaces open a fresh engine. */
  database?: Database;
  adminPrefix?: string;
  adminKey?: string;
  /** Options for namespaces opened after `default`, and for `default` when `database` is omitted. */
  databaseOptions?: DatabaseOptions;
}

const QUERY_CAP = 500;

const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const bounded = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("limit and offset must be non-negative integers");
  return value;
};

const asNumber = (value: unknown): number => {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return 0;
};

const point = (checkpoint: HistoryCheckpoint): SqlCheckpoint => ({
  id: checkpoint.id,
  branch: checkpoint.branch,
  parent: checkpoint.parent,
  at: checkpoint.at,
});

const touch = (db: Database): void => {
  if (!db.transactions.inTransaction) db.record();
};

const keyOf = (schema: string, table: string): string => `${schema}\u0000${table}`;

/**
 * One pass over the catalog for every table: three queries in total, grouped in maps, so the
 * listing is linear in the schema size rather than one catalog scan per table (issue #695).
 */
const listed = (db: Database): SqlTable[] => {
  const tables = db.query<{ table_schema: string; table_name: string; table_type: string }>(
    `SELECT table_schema, table_name, table_type
     FROM information_schema.tables
     WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
     ORDER BY table_schema, table_name`,
  );
  const columns = new Map<string, { name: string; type: string }[]>();
  for (const row of db.query<{ table_schema: string; table_name: string; column_name: string; data_type: string }>(
    `SELECT table_schema, table_name, column_name, data_type
     FROM information_schema.columns
     WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
     ORDER BY table_schema, table_name, ordinal_position`,
  )) {
    const key = keyOf(row.table_schema, row.table_name);
    const list = columns.get(key) ?? [];
    list.push({ name: row.column_name, type: row.data_type });
    columns.set(key, list);
  }
  const keys = new Map<string, Set<string>>();
  try {
    for (const row of db.query<{ table_schema: string; table_name: string; column_name: string }>(
      `SELECT kcu.table_schema, kcu.table_name, kcu.column_name
       FROM information_schema.key_column_usage kcu
       JOIN information_schema.table_constraints tc
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
        AND tc.table_name = kcu.table_name
       WHERE tc.constraint_type = 'PRIMARY KEY'
         AND kcu.table_schema NOT IN ('pg_catalog', 'information_schema')`,
    )) {
      const key = keyOf(row.table_schema, row.table_name);
      const set = keys.get(key) ?? new Set<string>();
      set.add(row.column_name);
      keys.set(key, set);
    }
  } catch {
    keys.clear();
  }
  return tables.map((row) => {
    const key = keyOf(row.table_schema, row.table_name);
    const primary = keys.get(key);
    return {
      schema: row.table_schema,
      name: row.table_name,
      kind: row.table_type === "VIEW" ? "view" : "table",
      columns: (columns.get(key) ?? []).map((column) => ({
        name: column.name,
        type: column.type,
        ...(primary?.has(column.name) ? { primaryKey: true } : {}),
      })),
    };
  });
};

/** Existence check for one listed relation, without describing every other table. */
const requireTable = (db: Database, schema: string, table: string): void => {
  if (schema === "pg_catalog" || schema === "information_schema") throw new Error(`no table ${schema}.${table}`);
  // Fast path: an ordinary table or view, looked up in the schema's maps. Anything else (temporary
  // schemas, foreign tables) falls back to the catalog view the listing reads.
  const stored = db.engineState.schemas.get(schema);
  if (stored?.tables.has(table) || stored?.views.get(table)?.materialized === false) return;
  const found = db.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = $1 AND table_name = $2
       AND table_schema NOT IN ('pg_catalog', 'information_schema')`,
    [schema, table],
  );
  if (found.length === 0) throw new Error(`no table ${schema}.${table}`);
};

const adapt = (db: Database): SqlEngine => ({
  tables: () => listed(db),
  page(schema, table, limit, offset): SqlPage {
    requireTable(db, schema, table);
    const from = `${quoteIdent(schema)}.${quoteIdent(table)}`;
    const take = bounded(limit);
    const skip = bounded(offset);
    const totalRow = db.query<{ count: unknown }>(`SELECT count(*) AS count FROM ${from}`);
    const total = asNumber(totalRow[0]?.count);
    // The result set carries its column names, so an empty table needs no catalog lookup.
    const result = db.prepare(`SELECT * FROM ${from} LIMIT ${take} OFFSET ${skip}`).result();
    return { columns: result.columns, rows: result.rows, total };
  },
  query(sql, params): SqlResult {
    const rows = db.query<Record<string, unknown>>(sql, params as BindValue[]);
    touch(db);
    const truncated = rows.length > QUERY_CAP;
    const sliced = truncated ? rows.slice(0, QUERY_CAP) : rows;
    return {
      columns: sliced[0] ? Object.keys(sliced[0]) : [],
      rows: sliced,
      rowCount: rows.length,
      ...(truncated ? { truncated: true } : {}),
    };
  },
  exec(sql) {
    db.exec(sql);
    touch(db);
    return { rowCount: db.changes };
  },
  checkpoint: (branch) => point(db.record(branch)),
  fork: (name, at) => point(at !== undefined ? db.fork(name, at) : db.fork(name)),
  checkout: (id, branch) => {
    db.checkout(id, branch);
  },
  retain: (id) => {
    db.timeline.retain(id);
  },
  release: (id) => db.timeline.release(id),
  inspect: () => ({ branches: db.history.branches(), checkpoints: db.history.checkpoints() }),
  reset: () => {
    db.reset();
  },
});

/** Admin fetch handler. SQL is only available through `/__admin`, not the wire server. */
export function createAdmin(options: AdminOptions = {}): EngineAdmin {
  const seeded = options.database;
  return createEngineAdmin({
    name: "postgres",
    dialect: "postgres",
    ...(options.adminPrefix !== undefined ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    open(namespace) {
      if (namespace === "default" && seeded) return adapt(seeded);
      return adapt(new Database(options.databaseOptions ?? {}));
    },
  });
}
