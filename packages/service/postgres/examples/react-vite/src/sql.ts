import { PostgresError, type ResultSet } from "@crvouga/postgres-mem";
import { getDb } from "./db.ts";

export type SqlErrorInfo = {
  message: string;
  category?: string;
  sqlState?: string;
};

export type SqlOutcome = { ok: true; result: ResultSet } | { ok: false; error: SqlErrorInfo };

export const SAMPLES: ReadonlyArray<{ label: string; sql: string }> = [
  {
    label: "Join + GROUP BY",
    sql: `SELECT a.name, count(ar.id) AS articles, coalesce(sum(ar.price), 0) AS total_price
FROM authors a
LEFT JOIN articles ar ON ar.author_id = a.id
GROUP BY a.id, a.name
ORDER BY a.id;`,
  },
  {
    label: "INSERT ... RETURNING",
    sql: `INSERT INTO articles (author_id, title, body, tags, price)
VALUES (1, 'Notes on RETURNING', 'Postgres returns the inserted row without a second query.', '{postgres,sql}', 4.75)
RETURNING id, title, price, published_at;`,
  },
  {
    label: "ON CONFLICT upsert",
    sql: `INSERT INTO authors (name, country) VALUES ('Ada Lovelace', 'UK')
ON CONFLICT (name) DO UPDATE SET country = excluded.country
RETURNING id, name, country;`,
  },
  {
    label: "DISTINCT ON",
    sql: `SELECT DISTINCT ON (ar.author_id) a.name, ar.title, ar.published_at
FROM articles ar
JOIN authors a ON a.id = ar.author_id
ORDER BY ar.author_id, ar.published_at DESC;`,
  },
  {
    label: "Window function",
    sql: `SELECT a.name, ar.title, ar.price,
  rank() OVER (PARTITION BY ar.author_id ORDER BY ar.price DESC NULLS LAST) AS price_rank
FROM articles ar
JOIN authors a ON a.id = ar.author_id
ORDER BY a.name, price_rank;`,
  },
  {
    label: "LATERAL",
    sql: `SELECT a.name, top.title, top.views
FROM authors a
CROSS JOIN LATERAL (
  SELECT ar.title, (ar.meta->>'views')::int AS views
  FROM articles ar
  WHERE ar.author_id = a.id
  ORDER BY (ar.meta->>'views')::int DESC NULLS LAST
  LIMIT 1
) top
ORDER BY top.views DESC NULLS LAST;`,
  },
  {
    label: "Arrays + unnest",
    sql: `SELECT tag, count(*) AS articles
FROM articles, unnest(tags) AS tag
GROUP BY tag
ORDER BY articles DESC, tag;`,
  },
  {
    label: "jsonb operators",
    sql: `SELECT title, meta->>'category' AS category, (meta->>'views')::int AS views
FROM articles
WHERE meta @> '{"featured": true}'
ORDER BY (meta->>'views')::int DESC;`,
  },
  {
    label: "Full-text search",
    sql: `SELECT ar.title, ts_rank(to_tsvector('english', ar.title || ' ' || ar.body), q.query) AS rank
FROM articles ar, to_tsquery('english', 'memory | compiler') AS q(query)
WHERE to_tsvector('english', ar.title || ' ' || ar.body) @@ q.query
ORDER BY rank DESC;`,
  },
  {
    label: "Recursive CTE",
    sql: `WITH RECURSIVE fib(n, current, next) AS (
  SELECT 1, 0::numeric, 1::numeric
  UNION ALL
  SELECT n + 1, next, current + next FROM fib WHERE n < 12
)
SELECT n, current AS fibonacci FROM fib;`,
  },
  {
    label: "generate_series",
    sql: `SELECT g.day::date AS day, count(ar.id) AS published
FROM generate_series(date '2024-01-01', date '2024-01-07', interval '1 day') AS g(day)
LEFT JOIN articles ar ON ar.published_at::date = g.day::date
GROUP BY g.day
ORDER BY g.day;`,
  },
  {
    label: "transaction()",
    sql: `-- Uses Database.transaction() when you click Run with this sample label.
-- SQL shown for documentation; the playground invokes transaction() in code.
INSERT INTO authors (name, country) VALUES ('Txn Author', 'US');
INSERT INTO articles (author_id, title, body) VALUES (currval('authors_id_seq')::int, 'Txn Article', 'Inserted inside Database.transaction().');
SELECT a.name, ar.title FROM authors a JOIN articles ar ON ar.author_id = a.id WHERE a.name = 'Txn Author';`,
  },
  {
    label: "now()",
    sql: `SELECT now() AS now, current_date AS today, version() AS version;`,
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
    if (err instanceof PostgresError) {
      return {
        ok: false,
        error: { message: err.message, category: err.category, sqlState: err.sqlState },
      };
    }
    return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
  }
}
