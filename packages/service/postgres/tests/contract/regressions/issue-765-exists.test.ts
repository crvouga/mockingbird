import { describe } from "bun:test";
import { execParity, parity, queryErrorParity, sequenceParity } from "../helpers.ts";

// #765: a correlated EXISTS / NOT EXISTS linked to the outer row only by `inner = outer` equalities
// runs as a hash semi / anti join, an uncorrelated subquery runs once per statement, and catalog
// relations are built once per statement. These pin the answers of every shape that takes (or must
// not take) those paths against PostgreSQL.

const SETUP = [
  "CREATE TABLE o (id int, k int, k8 bigint, kn numeric, s text, v varchar(10), flag bool)",
  `INSERT INTO o VALUES (1, 1, 1, 1.0, 'a', 'a', true), (2, 2, 2, 2.00, 'b', 'B', false),
     (3, NULL, NULL, NULL, NULL, NULL, NULL), (4, 4, 4, 4.5, 'c ', 'c', true), (5, 1, 1, 1, 'a', 'a', true),
     (6, 7, 7, 7.000, 'z', 'z', false)`,
  "CREATE TABLE i (id int, k int, k8 bigint, kn numeric, s text, n name, flag bool)",
  `INSERT INTO i VALUES (10, 1, 1, 1, 'a', 'a', true), (11, 1, 1, 1.000, 'a', 'a', false),
     (12, NULL, NULL, NULL, NULL, NULL, NULL), (13, 4, 4, 4, 'c', 'c', true), (14, 7, 7, 7, 'z', 'z', NULL)`,
];

const both = (name: string, where: string) => {
  parity(`#765 EXISTS ${name}`, SETUP, `SELECT id FROM o WHERE EXISTS (${where}) ORDER BY id`);
  parity(`#765 NOT EXISTS ${name}`, SETUP, `SELECT id FROM o WHERE NOT EXISTS (${where}) ORDER BY id`);
};

describe("#765 hash semi / anti join keys", () => {
  both("int4 = int4 with duplicates and NULLs", "SELECT 1 FROM i WHERE i.k = o.k");
  both("outer = inner (reversed sides)", "SELECT 1 FROM i WHERE o.k = i.k");
  both("int8 = int4", "SELECT 1 FROM i WHERE i.k8 = o.k");
  both("numeric = int4", "SELECT 1 FROM i WHERE i.kn = o.k");
  both("int4 = numeric (fractional outer)", "SELECT 1 FROM i WHERE i.k = o.kn");
  both("numeric = numeric with different scales", "SELECT 1 FROM i WHERE i.kn = o.kn");
  both("int8 = numeric", "SELECT 1 FROM i WHERE i.k8 = o.kn");
  both("text = text (trailing space matters)", "SELECT 1 FROM i WHERE i.s = o.s");
  both("name = text", "SELECT 1 FROM i WHERE i.n = o.s");
  both("text = varchar (case matters)", "SELECT 1 FROM i WHERE i.s = o.v");
  both("bool = bool", "SELECT 1 FROM i WHERE i.flag = o.flag");
  both("two correlating equalities", "SELECT 1 FROM i WHERE i.k = o.k AND i.flag = o.flag");
  both("expressions on both sides", "SELECT 1 FROM i WHERE i.k + 0 = o.k * 1");
  both("outer expression", "SELECT 1 FROM i WHERE i.k8 = o.id - 4");
  both("an unqualified inner column", "SELECT 1 FROM i WHERE k8 = o.k");
  both("an unqualified name that is inner (not correlated)", "SELECT 1 FROM i WHERE id = k");
  both("an unqualified outer-only column", "SELECT 1 FROM i WHERE i.s = v");
  both("SELECT * target", "SELECT * FROM i WHERE i.k = o.k");
  both("empty target list", "SELECT FROM i WHERE i.k = o.k");
  both("a constant inner predicate", "SELECT 1 FROM i WHERE i.k = o.k AND i.flag");
  both("an inner predicate that can be NULL", "SELECT 1 FROM i WHERE i.k = o.k AND i.flag IS NOT FALSE");
  both("an inner OR", "SELECT 1 FROM i WHERE i.k = o.k AND (i.id = 10 OR i.id = 14)");
  both("a join inside", "SELECT 1 FROM i JOIN i j ON j.id = i.id WHERE j.k = o.k AND i.flag");
  both("a comma join inside", "SELECT 1 FROM i, o o2 WHERE o2.id = i.id - 9 AND i.k = o.k");
  both("an inner subquery predicate", "SELECT 1 FROM i WHERE i.k = o.k AND i.id IN (SELECT id + 10 FROM o WHERE flag)");
  both("DISTINCT", "SELECT DISTINCT i.k FROM i WHERE i.k = o.k");
});

describe("#765 shapes that must keep the per-row subquery", () => {
  both("an outer reference outside the equality", "SELECT 1 FROM i WHERE i.k = o.k AND i.id > o.id + 6");
  both("an outer-only predicate", "SELECT 1 FROM i WHERE i.k = o.k AND o.flag");
  both("no inner column in the equality", "SELECT 1 FROM i WHERE o.k = 1");
  both("LIMIT 1", "SELECT 1 FROM i WHERE i.k = o.k LIMIT 1");
  both("LIMIT 0", "SELECT 1 FROM i WHERE i.k = o.k LIMIT 0");
  both("OFFSET", "SELECT 1 FROM i WHERE i.k = o.k OFFSET 1");
  both("an aggregate target (always one row)", "SELECT count(*) FROM i WHERE i.k = o.k");
  both("GROUP BY", "SELECT i.k FROM i WHERE i.k = o.k GROUP BY i.k");
  both("HAVING", "SELECT 1 FROM i WHERE i.k = o.k HAVING count(*) > 1");
  both("a set-returning target", "SELECT generate_series(1, 0) FROM i WHERE i.k = o.k");
  both("a UNION", "SELECT 1 FROM i WHERE i.k = o.k UNION SELECT 1 FROM i WHERE i.k8 = o.k + 6");
  both("a lateral function of the outer row", "SELECT 1 FROM unnest(ARRAY[o.k, 9]) AS u(x) WHERE u.x = o.k8");
  both(
    "nested EXISTS reaching the outermost row",
    `SELECT 1 FROM i WHERE i.k = o.k AND EXISTS (
     SELECT 1 FROM o o2 WHERE o2.s = i.s AND o2.id <> o.id)`,
  );
  both(
    "nested EXISTS of the inner row only",
    `SELECT 1 FROM i WHERE i.k = o.k AND NOT EXISTS (
     SELECT 1 FROM o o2 WHERE o2.k8 = i.k8 AND o2.flag IS FALSE)`,
  );
  both("a CTE inside", "WITH c AS (SELECT * FROM i WHERE flag) SELECT 1 FROM c WHERE c.k = o.k");
  queryErrorParity(
    "#765 EXISTS comparing text with int still fails",
    SETUP,
    "SELECT id FROM o WHERE EXISTS (SELECT 1 FROM i WHERE i.s = o.k)",
  );
  parity(
    "#765 EXISTS over an empty inner table",
    [...SETUP, "CREATE TABLE e (k int)"],
    "SELECT id, EXISTS (SELECT 1 FROM e WHERE e.k = o.k) AS x FROM o ORDER BY id",
  );
  parity(
    "#765 EXISTS with a bind parameter",
    SETUP,
    "SELECT id FROM o WHERE EXISTS (SELECT 1 FROM i WHERE i.k = o.k AND i.s = $1) ORDER BY id",
    ["a"],
  );
});

describe("#765 functions in a decorrelated EXISTS", () => {
  const FN_SETUP = [
    ...SETUP,
    "CREATE FUNCTION same765(int) RETURNS int LANGUAGE sql IMMUTABLE AS 'SELECT $1'",
    "CREATE FUNCTION vol765(int) RETURNS int LANGUAGE sql AS 'SELECT $1'",
    "CREATE TABLE log765 (n int)",
    "CREATE FUNCTION logged765(int) RETURNS int LANGUAGE plpgsql AS $$ BEGIN INSERT INTO log765 VALUES ($1); RETURN $1; END $$",
  ];
  parity(
    "#765 an immutable function on the outer side",
    FN_SETUP,
    "SELECT id FROM o WHERE EXISTS (SELECT 1 FROM i WHERE i.k = same765(o.k)) ORDER BY id",
  );
  parity(
    "#765 a volatile function on the outer side",
    FN_SETUP,
    "SELECT id FROM o WHERE NOT EXISTS (SELECT 1 FROM i WHERE i.k = vol765(o.k)) ORDER BY id",
  );
  parity(
    "#765 a volatile function on the inner side",
    FN_SETUP,
    "SELECT id FROM o WHERE EXISTS (SELECT 1 FROM i WHERE vol765(i.k) = o.k) ORDER BY id",
  );
  sequenceParity("#765 a writing function beside a correlated EXISTS runs once per row", FN_SETUP, [
    {
      sql: "SELECT id, logged765(id) AS l, EXISTS (SELECT 1 FROM i WHERE i.k = o.k) AS e FROM o ORDER BY id",
      query: true,
    },
    { sql: "SELECT n FROM log765 ORDER BY n", query: true },
  ]);
});

describe("#765 where EXISTS appears", () => {
  parity(
    "#765 EXISTS and NOT EXISTS in the select list",
    SETUP,
    `SELECT id, EXISTS (SELECT 1 FROM i WHERE i.k = o.k) AS e,
            NOT EXISTS (SELECT 1 FROM i WHERE i.s = o.s AND i.flag) AS ne FROM o ORDER BY id`,
  );
  parity(
    "#765 EXISTS in a join's ON clause",
    SETUP,
    `SELECT o.id, x.id AS xid FROM o LEFT JOIN o x ON x.id = o.id + 1 AND EXISTS (SELECT 1 FROM i WHERE i.k = x.k)
     ORDER BY 1, 2`,
  );
  parity(
    "#765 EXISTS under a grouped outer query",
    SETUP,
    `SELECT k, count(*) AS n, EXISTS (SELECT 1 FROM i WHERE i.k = o.k) AS e FROM o GROUP BY k ORDER BY k`,
  );
  parity(
    "#765 EXISTS inside a scalar subquery inside an ARRAY",
    SETUP,
    `SELECT ARRAY(SELECT x FROM unnest(ARRAY[1, 2, 4, NULL, 9]) AS u(x)
       WHERE NOT EXISTS (SELECT 1 FROM i WHERE i.k = u.x) ORDER BY x) AS missing`,
  );
  parity(
    "#765 uncorrelated IN / NOT IN / scalar subqueries per row",
    SETUP,
    `SELECT id, k IN (SELECT k FROM i WHERE flag) AS a, k NOT IN (SELECT k FROM i) AS b,
            k NOT IN (SELECT k FROM i WHERE k IS NOT NULL) AS c, (SELECT max(k) FROM i) - k AS d
     FROM o ORDER BY id`,
  );
  parity(
    "#765 correlated IN keeps per-row semantics",
    SETUP,
    `SELECT id, k IN (SELECT i.k FROM i WHERE i.s = o.s) AS a, k NOT IN (SELECT i.k FROM i WHERE i.s = o.s) AS b
     FROM o ORDER BY id`,
  );
  execParity(
    "#765 DELETE ... WHERE NOT EXISTS (anti join)",
    SETUP,
    "DELETE FROM o WHERE NOT EXISTS (SELECT 1 FROM i WHERE i.k = o.k)",
  );
  sequenceParity(
    "#765 UPDATE and DELETE with correlated EXISTS keep statement-snapshot results",
    SETUP,
    [
      { sql: "UPDATE o SET flag = NOT EXISTS (SELECT 1 FROM i WHERE i.s = o.s)" },
      { sql: "SELECT id, flag FROM o ORDER BY id", query: true },
      { sql: "DELETE FROM i WHERE EXISTS (SELECT 1 FROM i j WHERE j.k8 = i.k + 6)" },
      { sql: "SELECT id FROM i ORDER BY id", query: true },
      { sql: "DELETE FROM i WHERE EXISTS (SELECT 1 FROM i j WHERE j.k = i.k AND j.id <> i.id)" },
      { sql: "SELECT id FROM i ORDER BY id", query: true },
      {
        sql: "INSERT INTO i SELECT id + 100, k, k8, kn, s, s, flag FROM o WHERE NOT EXISTS (SELECT 1 FROM i WHERE i.k = o.k)",
      },
      { sql: "SELECT id, k FROM i ORDER BY id", query: true },
    ],
    { compareFinalState: true },
  );
});

describe("#765 catalog subqueries", () => {
  const CATALOG_SETUP = [
    "CREATE TABLE p765 (id int PRIMARY KEY, code text UNIQUE)",
    "CREATE TABLE c765 (id int PRIMARY KEY, p int REFERENCES p765 (id), note text)",
    "CREATE INDEX c765_note ON c765 (note)",
    "CREATE VIEW v765 AS SELECT id FROM c765",
  ];
  parity(
    "#765 relations with / without a column named id",
    CATALOG_SETUP,
    `SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v')
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'note') ORDER BY 1`,
  );
  parity(
    "#765 names missing from pg_class (unnest x NOT EXISTS pg_class JOIN pg_namespace)",
    CATALOG_SETUP,
    `SELECT expected.name FROM unnest(ARRAY['p765', 'v765', 'nope', 'c765_note']) AS expected(name)
     WHERE NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                       WHERE n.nspname = 'public' AND c.relname = expected.name AND c.relkind IN ('r', 'v'))
     ORDER BY 1`,
  );
  parity(
    "#765 missing columns / indexes through information_schema and pg_indexes",
    CATALOG_SETUP,
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1::text) AS t,
       ARRAY(SELECT x.name FROM unnest($2::text[]) AS x(name) WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = $1::text AND column_name = x.name) ORDER BY 1) AS cols,
       ARRAY(SELECT x.name FROM unnest($3::text[]) AS x(name) WHERE NOT EXISTS (SELECT 1 FROM pg_indexes
             WHERE schemaname = 'public' AND tablename = $1::text AND indexname = x.name) ORDER BY 1) AS idx`,
    ["c765", "{id,p,note,gone}", "{c765_note,c765_pkey,gone_idx}"],
  );
  parity(
    "#765 constraints without a dependent index",
    CATALOG_SETUP,
    `SELECT conname FROM pg_constraint con WHERE con.connamespace = 'public'::regnamespace AND con.contype <> 'f'
       AND NOT EXISTS (SELECT 1 FROM pg_index ix WHERE ix.indexrelid = con.conindid) ORDER BY 1`,
  );
  sequenceParity("#765 catalog answers follow DDL, ROLLBACK and functions in the same session", CATALOG_SETUP, [
    { sql: "BEGIN" },
    {
      sql: `SELECT x FROM unnest(ARRAY['t765a', 'p765']) AS u(x)
              WHERE EXISTS (SELECT 1 FROM pg_class c WHERE c.relname = u.x) ORDER BY 1`,
      query: true,
    },
    { sql: "CREATE TABLE t765a (z int)" },
    {
      sql: `SELECT x FROM unnest(ARRAY['t765a', 'p765']) AS u(x)
              WHERE EXISTS (SELECT 1 FROM pg_class c WHERE c.relname = u.x) ORDER BY 1`,
      query: true,
    },
    { sql: "ROLLBACK" },
    {
      sql: `SELECT x FROM unnest(ARRAY['t765a', 'p765']) AS u(x)
              WHERE EXISTS (SELECT 1 FROM pg_class c WHERE c.relname = u.x) ORDER BY 1`,
      query: true,
    },
    {
      sql: `CREATE FUNCTION f765(n text) RETURNS int LANGUAGE plpgsql AS $$
              DECLARE r int;
              BEGIN
                SELECT count(*) INTO r FROM unnest(ARRAY[n]) AS u(x)
                  WHERE EXISTS (SELECT 1 FROM pg_class c WHERE c.relname = u.x);
                EXECUTE format('CREATE TABLE %I (z int)', n);
                RETURN r * 10 + (SELECT count(*) FROM unnest(ARRAY[n]) AS u(x)
                  WHERE EXISTS (SELECT 1 FROM pg_class c WHERE c.relname = u.x));
              END $$`,
    },
    { sql: "SELECT f765('t765b') AS r", query: true },
    {
      sql: `SELECT x FROM unnest(ARRAY['t765b', 't765c']) AS u(x)
              WHERE EXISTS (SELECT 1 FROM pg_class c WHERE c.relname = u.x) ORDER BY 1`,
      query: true,
    },
  ]);
});
