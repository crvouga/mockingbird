/**
 * Capture oracle results for browser SQL smoke (run against the real PGlite oracle).
 *   bun run fixtures:browser
 *
 * Values are recorded as canonical Postgres text (identity parsers for every
 * pg_type OID), then every fixture is verified in-process against postgres-mem
 * with String()-normalized comparison — the same normalization the browser
 * smoke applies. Boolean-valued expressions are cast to ::text in the fixture
 * SQL so both sides render identically ("true"/"false" instead of "t"/"f").
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { type BindValue, Database } from "../src/index.ts";

const ROOT = join(import.meta.dir, "..");
mkdirSync(join(ROOT, "tests/browser"), { recursive: true });

interface FixtureCase {
  id: string;
  setup: string[];
  sql: string;
  params?: unknown[];
}

const cases: FixtureCase[] = [
  { id: "select-1", setup: [], sql: "SELECT 1 AS v" },
  {
    id: "typing",
    setup: [],
    sql: "SELECT pg_typeof(42)::text AS ti, pg_typeof(4.2)::text AS tn, '42'::int AS i, '4.5'::numeric AS n",
  },
  {
    id: "join",
    setup: [
      "CREATE TABLE a(id int, n text)",
      "CREATE TABLE b(id int, a_id int)",
      "INSERT INTO a VALUES (1,'x'),(2,'y')",
      "INSERT INTO b VALUES (10,1),(20,2)",
    ],
    sql: "SELECT a.n, b.id FROM a JOIN b ON a.id = b.a_id ORDER BY b.id",
  },
  {
    id: "null-3vl",
    setup: [],
    sql: "SELECT (NULL = NULL)::text AS eq, (NULL IS NULL)::text AS isn, (1 IN (1, NULL))::text AS inn",
  },
  {
    id: "bind",
    setup: ["CREATE TABLE t(x int)", "INSERT INTO t VALUES (1),(2),(3)"],
    sql: "SELECT x FROM t WHERE x > $1 ORDER BY x",
    params: [1],
  },
  {
    id: "introspection",
    setup: ["CREATE TABLE users(id int PRIMARY KEY, name text NOT NULL)"],
    sql: "SELECT table_name FROM information_schema.tables WHERE table_name = 'users'",
  },
  {
    id: "window",
    setup: ["CREATE TABLE t(x int)", "INSERT INTO t VALUES (1),(2),(3)"],
    sql: "SELECT x, row_number() OVER (ORDER BY x) AS rn FROM t ORDER BY x",
  },
  {
    id: "jsonb",
    setup: [],
    sql: `SELECT '{"a":1}'::jsonb->>'a' AS a`,
  },
  {
    id: "aggregate",
    setup: ["CREATE TABLE s(g text, v int)", "INSERT INTO s VALUES ('a',1),('a',2),('b',3)"],
    sql: "SELECT g, count(*) AS c, sum(v) AS total FROM s GROUP BY g ORDER BY g",
  },
  {
    id: "tsvector",
    setup: [],
    sql: "SELECT (to_tsvector('english','hello world') @@ to_tsquery('hello'))::text AS m",
  },
];

const norm = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

const oracle = new PGlite();
await oracle.waitReady;
// PGlite's WASM boot leaks process.exitCode = 99 (electric-sql/pglite#975).
process.exitCode = 0;

const oidRes = await oracle.query<{ oid: number }>("SELECT oid FROM pg_type");
const parsers: Record<number, (x: string) => string> = {};
for (const row of oidRes.rows) parsers[Number(row.oid)] = (x) => x;

const versionRes = await oracle.query<{ v: string }>("SELECT current_setting('server_version') AS v");
const oracleVersion = versionRes.rows[0]?.v ?? "";

async function captureExpected(c: FixtureCase): Promise<{ columns: string[]; values: (string | null)[][] }> {
  await oracle.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  for (const s of c.setup) await oracle.exec(s);
  const options = { parsers, rowMode: "array" } as Parameters<PGlite["query"]>[2];
  const res = await oracle.query(c.sql, c.params ?? [], options);
  const columns = res.fields.map((f) => f.name);
  const values = (res.rows as unknown as unknown[][]).map((row) => row.map(norm));
  return { columns, values };
}

function runAgainstMem(c: FixtureCase): { columns: string[]; values: (string | null)[][] } {
  const db = new Database();
  for (const s of c.setup) db.exec(s);
  const rs = db.prepare(c.sql).result(...((c.params ?? []) as BindValue[]));
  return {
    columns: rs.columns,
    values: rs.rows.map((row) => rs.columns.map((col) => norm(row[col]))),
  };
}

const out: {
  version: number;
  oracleVersion: string;
  cases: (FixtureCase & { expect: { columns: string[]; values: (string | null)[][] } })[];
} = { version: 1, oracleVersion, cases: [] };

const failures: string[] = [];
for (const c of cases) {
  const expect = await captureExpected(c);
  try {
    const got = runAgainstMem(c);
    if (JSON.stringify(got) !== JSON.stringify(expect)) {
      failures.push(`${c.id}: mem ${JSON.stringify(got)} ≠ oracle ${JSON.stringify(expect)}`);
      continue;
    }
  } catch (error) {
    failures.push(`${c.id}: postgres-mem threw: ${(error as Error).message}`);
    continue;
  }
  out.cases.push({ ...c, expect });
}

if (failures.length > 0) {
  console.error("fixture verification against postgres-mem FAILED:");
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

const fixturesPath = join(ROOT, "tests/browser/fixtures.json");
writeFileSync(fixturesPath, `${JSON.stringify(out, null, 2)}\n`);
// tests/browser/ is not excluded from Biome formatting; keep the generated file check-clean.
Bun.spawnSync(["bunx", "biome", "format", "--write", fixturesPath], { cwd: ROOT });
console.log(`Wrote ${out.cases.length} fixtures (oracle ${oracleVersion}); all verified against postgres-mem`);
process.exit(0);
