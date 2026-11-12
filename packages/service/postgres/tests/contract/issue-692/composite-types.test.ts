import { expect, test } from "bun:test";
import { Database, Snapshot } from "../../../src/index.ts";
import { errorParity, parity, parityTyped, queryErrorParity, sequenceParity } from "../helpers.ts";

// #692: composite types — CREATE TYPE ... AS (...), row constructors, field access, I/O, columns.

const q = (sql: string) => ({ sql, query: true });
const pair = ["CREATE TYPE pair AS (a int, b text)"];
const table = [
  ...pair,
  "CREATE TABLE t (id int, p pair)",
  "INSERT INTO t VALUES (1, ROW(1, 'foo')), (2, '(2,bar)'), (3, NULL), (4, (NULL, NULL))",
];

parity(
  "row constructors cast to a composite, and field access",
  pair,
  "SELECT ROW(1, 'foo')::pair AS p, (ROW(1, 'foo')::pair).a AS a, (ROW(1, 'foo')::pair).b AS b, (1.6, 7)::pair AS coerced",
);
parity(
  "text input and output",
  pair,
  `SELECT '(1,foo)'::pair AS p, ('(2,"x y")'::pair).b AS spaced, '(,)'::pair AS e, ('(,)'::pair).a IS NULL AS n, '(3,"")'::pair AS empty_text, ('(4,"a""b")'::pair).b AS quote, '(5,"a,b")'::pair AS comma, ' (6,z) '::pair AS padded`,
);
parityTyped("composite types in pg_typeof", table, "SELECT p, (p).a, (p).b FROM t ORDER BY id");
queryErrorParity("too few fields", pair, "SELECT '(1)'::pair", "invalid_text_representation");
queryErrorParity("too many fields", pair, "SELECT '(1,a,b)'::pair", "invalid_text_representation");
queryErrorParity("a field of the wrong type", pair, "SELECT '(a,b)'::pair", "invalid_text_representation");
queryErrorParity("a row of the wrong width", pair, "SELECT ROW(1, 2, 3)::pair", "datatype_mismatch");
queryErrorParity("a missing field", pair, "SELECT (ROW(1, 'a')::pair).nope", "undefined_column");
parity(
  "comparison, grouping and DISTINCT",
  table,
  "SELECT (1, 'x')::pair = (1, 'x')::pair AS eq, (1, 'x')::pair < (2, 'a')::pair AS lt, (SELECT count(DISTINCT p) FROM t) AS d, (SELECT count(*) FROM t WHERE p = '(2,bar)'::pair) AS hit",
);
parity(
  "a composite column",
  table,
  "SELECT id, p, (p).a, (t.p).b, p IS NULL AS isnull, p IS NOT NULL AS notnull FROM t ORDER BY id",
);
parity("(composite).* expands its attributes", table, "SELECT id, (p).* FROM t ORDER BY id");
sequenceParity(
  "UPDATE a whole composite and single fields",
  table,
  [
    { sql: "UPDATE t SET p.a = 10 WHERE id = 1" },
    q("UPDATE t SET p = ROW(5, 'five') WHERE id = 2 RETURNING p"),
    { sql: "UPDATE t SET p.b = 'set', p.a = 7 WHERE id = 3" },
    q("SELECT id, p FROM t ORDER BY id"),
  ],
  { compareFinalState: true },
);
errorParity("assigning a missing field", table, "UPDATE t SET p.nope = 1", "undefined_column");
errorParity("assigning a field of a non-composite", table, "UPDATE t SET id.x = 1", "datatype_mismatch");
parity(
  "arrays of composites",
  pair,
  "SELECT ARRAY[ROW(1, 'a')::pair, ROW(2, 'b c')::pair] AS arr, (ARRAY[ROW(1, 'a')::pair])[1] AS first",
);
parity("composites to JSON", pair, "SELECT row_to_json(ROW(1, 'x')::pair) AS j, to_jsonb(ROW(1, 'x')::pair) AS jb");
parity(
  "json[b]_populate_record and _recordset",
  pair,
  `SELECT jsonb_populate_record(NULL::pair, '{"a": 3, "b": "z"}') AS r, (jsonb_populate_record('(1,keep)'::pair, '{"a": 3}')).b AS kept, json_populate_record(NULL::pair, '{"b": "j"}') AS j`,
);
parity(
  "populate_recordset in FROM",
  pair,
  `SELECT * FROM jsonb_populate_recordset(NULL::pair, '[{"a": 1}, {"b": "x"}]')`,
);
parity(
  "populate_record in FROM",
  pair,
  `SELECT * FROM jsonb_populate_record(NULL::pair, '{"a": 3, "b": "z", "c": 1}')`,
);
queryErrorParity("populate_record from an array", pair, "SELECT jsonb_populate_record(NULL::pair, '[1]')");
sequenceParity("a function returning a composite", pair, [
  { sql: "CREATE FUNCTION mk(i int) RETURNS pair LANGUAGE sql AS $$ SELECT ROW(i, 'v' || i)::pair $$" },
  q("SELECT mk(3) AS m, (mk(3)).b AS b"),
  q("SELECT * FROM mk(4)"),
]);
parity(
  "nested composites",
  ["CREATE TYPE inner_t AS (x int, y int)", "CREATE TYPE outer_t AS (i inner_t, label text)"],
  `SELECT ROW(ROW(1, 2), 'z')::outer_t AS o, ((ROW(ROW(1, 2), 'z')::outer_t).i).y AS y, '("(1,2)",z)'::outer_t AS parsed`,
);
parity("an empty composite", ["CREATE TYPE e AS ()"], "SELECT ROW()::e AS r");
parity(
  "catalog rows of a composite type",
  pair,
  "SELECT t.typname, t.typtype, t.typrelid <> 0 AS hasrel, t.typarray <> 0 AS hasarr, c.relkind, (SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' ORDER BY attnum) FROM pg_attribute WHERE attrelid = 'pair'::regclass) AS attrs FROM pg_type t LEFT JOIN pg_class c ON c.oid = t.typrelid WHERE t.typname IN ('pair', '_pair') ORDER BY 1",
);
errorParity("a type that exists", pair, "CREATE TYPE pair AS (x int)", "duplicate_object");
errorParity("a duplicate attribute", [], "CREATE TYPE d AS (x int, x text)", "duplicate_object");
sequenceParity("ALTER TYPE ADD / DROP / RENAME ATTRIBUTE and RENAME TO rewrite stored values", table, [
  { sql: "ALTER TYPE pair ADD ATTRIBUTE c bool" },
  q("SELECT id, p FROM t ORDER BY id"),
  { sql: "ALTER TYPE pair DROP ATTRIBUTE b" },
  q("SELECT id, p FROM t ORDER BY id"),
  { sql: "ALTER TYPE pair RENAME ATTRIBUTE a TO aa" },
  q("SELECT id, (p).aa FROM t ORDER BY id"),
  { sql: "ALTER TYPE pair RENAME TO duo" },
  q("SELECT pg_typeof(p) AS ty, p FROM t ORDER BY id"),
]);
errorParity("DROP TYPE with dependents", table, "DROP TYPE pair");
errorParity(
  "ALTER ATTRIBUTE TYPE of a type a column uses",
  table,
  "ALTER TYPE pair ALTER ATTRIBUTE a TYPE bigint",
  "unsupported",
);
sequenceParity("ALTER ATTRIBUTE TYPE of an unused type", pair, [
  { sql: "ALTER TYPE pair ALTER ATTRIBUTE a TYPE bigint" },
  q("SELECT pg_typeof(('(1,x)'::pair).a) AS ty"),
]);
sequenceParity(
  "DROP TYPE CASCADE drops the columns",
  table,
  [{ sql: "DROP TYPE pair CASCADE" }, q("SELECT * FROM t ORDER BY id")],
  {
    compareFinalState: true,
  },
);
sequenceParity("DROP TYPE IF EXISTS", pair, [
  { sql: "DROP TYPE IF EXISTS pair, nope" },
  q("SELECT count(*) FROM pg_type WHERE typname = 'pair'"),
]);

test("composite values survive an encoded snapshot and a rollback", () => {
  const db = new Database();
  for (const sql of table) db.exec(sql);
  db.exec("BEGIN");
  db.exec("ALTER TYPE pair ADD ATTRIBUTE c int");
  db.exec("ROLLBACK");
  const copy = Snapshot.decode(db.snapshot().encode()).open();
  expect(copy.query("SELECT id, p::text AS p, (p).b AS b FROM t ORDER BY id")).toEqual([
    { id: 1, p: "(1,foo)", b: "foo" },
    { id: 2, p: "(2,bar)", b: "bar" },
    { id: 3, p: null, b: null },
    { id: 4, p: "(,)", b: null },
  ]);
});
