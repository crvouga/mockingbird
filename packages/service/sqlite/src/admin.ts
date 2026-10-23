/**
 * The shared mock admin API in front of an in-memory SQLite database.
 * `GET /__admin/ui` is the shell; `GET /sql/tables` and `POST /sql/query` feed the explorer.
 *
 * @module
 */
// Relative on purpose. A package dependency on @crvouga/mockingbird-service makes a
// Turbo build cycle: that package depends on @crvouga/mockingbird-sqlite, which depends
// on this package. The admin bundle inlines this module.
import {
  createEngineAdmin,
  type EngineAdmin,
  type SqlCheckpoint,
  type SqlColumn,
  type SqlEngine,
  type SqlPage,
  type SqlResult,
  type SqlTable,
} from "../../core/src/engine-admin.ts";
import { Database, type DatabaseOptions, type HistoryCheckpoint } from "./api/database.ts";
import type { BindValue } from "./types/value.ts";

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

const columnsOf = (db: Database, name: string): SqlColumn[] => {
  try {
    return db
      .query<{ name: string; type: string; pk: number }>(`PRAGMA table_info(${quoteIdent(name)})`)
      .map((column) => ({
        name: column.name,
        type: column.type,
        ...(column.pk > 0 ? { primaryKey: true } : {}),
      }));
  } catch {
    return [];
  }
};

const listed = (db: Database): SqlTable[] =>
  db
    .query<{ type: string; name: string }>(
      `SELECT type, name FROM sqlite_master
       WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .map((row) => ({
      schema: "main",
      name: row.name,
      kind: row.type === "view" ? "view" : "table",
      columns: columnsOf(db, row.name),
    }));

const requireTable = (db: Database, schema: string, table: string): SqlTable => {
  const found = listed(db).find((item) => item.schema === schema && item.name === table);
  if (!found) throw new Error(`no table ${schema}.${table}`);
  return found;
};

const adapt = (db: Database): SqlEngine => ({
  tables: () => listed(db),
  page(schema, table, limit, offset): SqlPage {
    const found = requireTable(db, schema, table);
    const from = quoteIdent(table);
    const take = bounded(limit);
    const skip = bounded(offset);
    const totalRow = db.query<{ count: unknown }>(`SELECT count(*) AS count FROM ${from}`);
    const total = asNumber(totalRow[0]?.count);
    const rows = db.query<Record<string, unknown>>(`SELECT * FROM ${from} LIMIT ${take} OFFSET ${skip}`);
    return {
      columns: rows[0] ? Object.keys(rows[0]) : found.columns.map((column) => column.name),
      rows,
      total,
    };
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

/** Admin fetch handler. SQL is only available through `/__admin`. */
export function createAdmin(options: AdminOptions = {}): EngineAdmin {
  const seeded = options.database;
  return createEngineAdmin({
    name: "sqlite",
    dialect: "sqlite",
    ...(options.adminPrefix !== undefined ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    open(namespace) {
      if (namespace === "default" && seeded) return adapt(seeded);
      return adapt(new Database(options.databaseOptions ?? {}));
    },
  });
}
