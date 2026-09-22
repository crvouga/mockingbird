import { expectParity } from "./assert.ts";
import type { ContractDb, QueryResult } from "./types.ts";

// FZZ-snap-03: extended logical dump includes views, materialized views, and sequences
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

const TABLES_SQL =
  "SELECT table_schema, table_name FROM information_schema.tables " +
  "WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_type = 'BASE TABLE' " +
  "ORDER BY table_schema, table_name";

const VIEWS_SQL =
  "SELECT table_schema, table_name FROM information_schema.views " +
  "WHERE table_schema NOT IN ('pg_catalog', 'information_schema') " +
  "ORDER BY table_schema, table_name";

const MATVIEWS_SQL =
  "SELECT schemaname, matviewname FROM pg_matviews " +
  "WHERE schemaname NOT IN ('pg_catalog', 'information_schema') " +
  "ORDER BY schemaname, matviewname";

const SEQUENCES_SQL =
  "SELECT schemaname, sequencename, last_value::text AS last_value FROM pg_sequences " +
  "WHERE schemaname NOT IN ('pg_catalog', 'information_schema') " +
  "ORDER BY schemaname, sequencename";

async function dumpRelationChunk(
  db: ContractDb,
  schema: string,
  name: string,
  section: string,
): Promise<string | null> {
  const cols = await db.query(
    "SELECT column_name FROM information_schema.columns " +
      `WHERE table_schema = '${schema}' AND table_name = '${name}' ORDER BY ordinal_position`,
  );
  if (!cols.ok) return null;
  let colList = cols.values.map((r) => quoteIdent(r[0]!));
  if (colList.length === 0) {
    const probe = await db.query(`SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(name)} LIMIT 0`);
    if (!probe.ok) return null;
    colList = probe.columns.map((c) => quoteIdent(c));
  }
  if (colList.length === 0) return null;
  const rendered = colList.map((c) => `coalesce(${c}::text, '<NULL>')`).join(" || '|' || ");
  return `SELECT '${section}:${schema}.${name}' AS tbl, s FROM (SELECT ${rendered} AS s FROM ${quoteIdent(schema)}.${quoteIdent(name)} ORDER BY 1) x`;
}

/**
 * Dump user tables, views, materialized views, and sequence counters as one
 * comparable result (text-rendered rows, deterministic ordering).
 */
export async function dumpLogicalState(db: ContractDb): Promise<QueryResult> {
  const chunks: string[] = [];

  const tables = await db.query(TABLES_SQL);
  if (!tables.ok) return tables;
  for (const row of tables.values) {
    const chunk = await dumpRelationChunk(db, row[0]!, row[1]!, "table");
    if (chunk) chunks.push(chunk);
  }

  const views = await db.query(VIEWS_SQL);
  if (!views.ok) return views;
  for (const row of views.values) {
    const chunk = await dumpRelationChunk(db, row[0]!, row[1]!, "view");
    if (chunk) chunks.push(chunk);
  }

  const matviews = await db.query(MATVIEWS_SQL);
  if (!matviews.ok) return matviews;
  for (const row of matviews.values) {
    const chunk = await dumpRelationChunk(db, row[0]!, row[1]!, "matview");
    if (chunk) chunks.push(chunk);
  }

  const sequences = await db.query(SEQUENCES_SQL);
  if (!sequences.ok) return sequences;
  for (const row of sequences.values) {
    const schema = row[0]!;
    const name = row[1]!;
    const last = String(row[2] ?? "<NULL>").replaceAll("'", "''");
    chunks.push(`SELECT 'seq:${schema}.${name}' AS tbl, '${last}' AS s`);
  }

  if (chunks.length === 0) return db.query("SELECT NULL::text AS tbl, NULL::text AS s WHERE false");
  return db.query(chunks.join(" UNION ALL "));
}

/**
 * Compare full user-object state across both backends: tables, views,
 * materialized views, and sequence counters.
 */
export async function expectStateParity(memory: ContractDb, postgres: ContractDb): Promise<void> {
  const da = await dumpLogicalState(memory);
  const db = await dumpLogicalState(postgres);
  expectParity(da, db, { ignoreWriteCounters: true, unordered: true });
}
