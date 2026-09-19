import { type ResultSet, SqliteError } from "@crvouga/sqlite-mem";
import { getDb } from "./db.ts";

export type SqlErrorInfo = {
  message: string;
  category?: string;
  sqliteCode?: string;
};

export type SqlOutcome = { ok: true; result: ResultSet } | { ok: false; error: SqlErrorInfo };

export const SAMPLES: ReadonlyArray<{ label: string; sql: string }> = [
  {
    label: "Join + GROUP BY",
    sql: `SELECT u.name, count(p.id) AS posts
FROM users u
LEFT JOIN posts p ON p.user_id = u.id
GROUP BY u.id, u.name
ORDER BY u.id;`,
  },
  {
    label: "Insert user (exec + query)",
    sql: `INSERT INTO users (name) VALUES ('Carol');
SELECT * FROM users ORDER BY id;`,
  },
  {
    label: "transaction()",
    sql: `-- Uses Database.transaction() when you click Run with this sample label.
-- SQL shown for documentation; the playground invokes transaction() in code.
INSERT INTO users (name) VALUES ('TxnUser');
INSERT INTO posts (user_id, title) VALUES (last_insert_rowid(), 'Txn Post');
SELECT u.name, p.title FROM users u JOIN posts p ON p.user_id = u.id WHERE u.name = 'TxnUser';`,
  },
  {
    label: "json_object",
    sql: `SELECT json_object('id', id, 'name', name) AS user FROM users ORDER BY id;`,
  },
  {
    label: "date('now')",
    sql: `SELECT date('now') AS today, datetime('now') AS now;`,
  },
];

export const DEFAULT_SQL = SAMPLES[0]?.sql ?? "SELECT 1;";

function splitStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Strip leading full-line SQL comments so scripts can document behavior. */
function stripLeadingComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n")
    .trim();
}

export function runSql(sql: string, options?: { useTransaction?: boolean }): SqlOutcome {
  try {
    const db = getDb();
    const cleaned = stripLeadingComments(sql);
    const parts = splitStatements(cleaned);
    if (parts.length === 0) {
      return { ok: false, error: { message: "empty statement", category: "misuse" } };
    }

    const runParts = () => {
      if (parts.length === 1) {
        return db.prepare(parts[0]!).result();
      }
      // Multi-statement: exec all but the last (discards rows), then result() the final SELECT/DML.
      const head = parts.slice(0, -1).join(";\n");
      db.exec(head);
      return db.prepare(parts[parts.length - 1]!).result();
    };

    const result = options?.useTransaction ? db.transaction(runParts) : runParts();
    return { ok: true, result };
  } catch (err) {
    if (err instanceof SqliteError) {
      return {
        ok: false,
        error: { message: err.message, category: err.category, sqliteCode: err.sqliteCode },
      };
    }
    return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
  }
}
