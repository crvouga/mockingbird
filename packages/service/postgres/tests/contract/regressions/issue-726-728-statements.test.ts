import { describe, expect } from "bun:test";
import { matrixBoth } from "../../harness/matrix.ts";
import { errorParity, parity, parityTyped, queryErrorParity, sequenceParity } from "../helpers.ts";

// #726 / #728: statement-level gaps reported against the engine, each checked against PostgreSQL 18.3.

describe("#726 CREATE TEMP TABLE ... ON COMMIT ... AS query", () => {
  sequenceParity(
    "ON COMMIT DROP with AS SELECT: readable in the transaction, gone at commit",
    [],
    [
      { sql: "BEGIN" },
      { sql: "CREATE TEMP TABLE x ON COMMIT DROP AS SELECT 1 AS a" },
      { sql: "SELECT * FROM x", query: true },
      { sql: "COMMIT" },
      { sql: "SELECT count(*)::int AS n FROM pg_class WHERE relname = 'x'", query: true },
    ],
    { compareFinalState: true },
  );

  sequenceParity(
    "the reported script in one call",
    [],
    [
      { sql: "begin; create temp table x on commit drop as select 1 as a; select * from x; commit;" },
      { sql: "SELECT count(*)::int AS n FROM pg_class WHERE relname = 'x'", query: true },
    ],
    { compareFinalState: true },
  );

  sequenceParity(
    "ON COMMIT DROP outside a transaction block drops at the end of the statement",
    [],
    [
      { sql: "CREATE TEMP TABLE x2 ON COMMIT DROP AS SELECT 1 AS a" },
      { sql: "SELECT count(*)::int AS n FROM pg_class WHERE relname = 'x2'", query: true },
      { sql: "CREATE TEMP TABLE x3 (a int) ON COMMIT DROP" },
      { sql: "SELECT count(*)::int AS n FROM pg_class WHERE relname = 'x3'", query: true },
    ],
    { compareFinalState: true },
  );

  sequenceParity(
    "ON COMMIT DELETE ROWS empties the table at every commit",
    [],
    [
      { sql: "CREATE TEMP TABLE y (a int) ON COMMIT DELETE ROWS" },
      { sql: "INSERT INTO y VALUES (1)" },
      { sql: "SELECT * FROM y", query: true },
      { sql: "BEGIN" },
      { sql: "INSERT INTO y VALUES (2)" },
      { sql: "SELECT * FROM y", query: true },
      { sql: "COMMIT" },
      { sql: "SELECT * FROM y", query: true },
      { sql: "CREATE TEMP TABLE w ON COMMIT DELETE ROWS AS SELECT 1 AS a" },
      { sql: "SELECT * FROM w", query: true },
    ],
    { compareFinalState: true },
  );

  sequenceParity(
    "column list, WITH (...), ON COMMIT PRESERVE ROWS, TABLESPACE and WITH NO DATA",
    [],
    [
      { sql: "CREATE TEMP TABLE v (a) WITH (fillfactor = 70) ON COMMIT PRESERVE ROWS AS SELECT 1 WITH NO DATA" },
      { sql: "SELECT * FROM v", query: true },
      { sql: "CREATE TEMP TABLE v2 (a, b) ON COMMIT PRESERVE ROWS TABLESPACE pg_default AS SELECT 1, 'x'" },
      { sql: "SELECT * FROM v2", query: true },
      { sql: "CREATE TABLE v3 WITH (fillfactor = 70) AS SELECT 2 AS q" },
      { sql: "SELECT * FROM v3", query: true },
    ],
    { compareFinalState: true },
  );

  sequenceParity(
    "a table dropped on commit by a rolled-back savepoint never existed; the rest go at commit",
    [],
    [
      { sql: "BEGIN" },
      { sql: "CREATE TEMP TABLE k1 (a int) ON COMMIT DROP" },
      { sql: "SAVEPOINT s" },
      { sql: "CREATE TEMP TABLE k2 ON COMMIT DROP AS SELECT 1 AS a" },
      { sql: "ROLLBACK TO s" },
      { sql: "COMMIT" },
      { sql: "SELECT relname FROM pg_class WHERE relname LIKE 'k_' ORDER BY relname", query: true },
    ],
    { compareFinalState: true },
  );

  sequenceParity(
    "ROLLBACK takes back an ON COMMIT DROP table too",
    [],
    [
      { sql: "BEGIN" },
      { sql: "CREATE TEMP TABLE r1 ON COMMIT DROP AS SELECT 1 AS a" },
      { sql: "ROLLBACK" },
      { sql: "SELECT count(*)::int AS n FROM pg_class WHERE relname = 'r1'", query: true },
    ],
    { compareFinalState: true },
  );

  errorParity("ON COMMIT on a permanent table", [], "CREATE TABLE z (a int) ON COMMIT DROP");
  errorParity("ON COMMIT on a permanent CREATE TABLE AS", [], "CREATE TABLE z ON COMMIT DELETE ROWS AS SELECT 1");
});

describe("#726 DECLARE ... NO SCROLL CURSOR / FETCH / MOVE / CLOSE in a transaction", () => {
  sequenceParity(
    "cursor walk over 250 rows",
    ["CREATE TABLE cur_t AS SELECT g AS id FROM generate_series(1, 250) g"],
    [
      { sql: "BEGIN" },
      { sql: "DECLARE c NO SCROLL CURSOR FOR SELECT id FROM cur_t ORDER BY id" },
      { sql: "FETCH 100 FROM c", query: true },
      { sql: "FETCH FORWARD 3 FROM c", query: true },
      { sql: "MOVE 50 IN c" },
      { sql: "FETCH NEXT FROM c", query: true },
      { sql: "FETCH ALL FROM c", query: true },
      { sql: "FETCH 100 FROM c", query: true },
      { sql: "CLOSE c" },
      { sql: "COMMIT" },
    ],
  );
});

describe("#728 RETURNING sees UPDATE ... FROM and DELETE ... USING tables", () => {
  const setup = [
    "CREATE TABLE t (id int, name text)",
    "CREATE TABLE c (id int, tid int, v text)",
    "INSERT INTO t VALUES (1, 'a'), (2, 'b')",
    "INSERT INTO c VALUES (10, 1, 'z'), (11, 2, 'y'), (12, 3, 'x')",
  ];
  parity(
    "UPDATE ... FROM RETURNING a FROM column",
    setup,
    "UPDATE c SET v = 'q' FROM t WHERE t.id = c.tid RETURNING t.name, c.id",
  );
  parity("UPDATE ... FROM RETURNING *", setup, "UPDATE c SET v = 'r' FROM t WHERE t.id = c.tid RETURNING *");
  parity(
    "UPDATE ... FROM RETURNING t.*, a bare FROM-only column",
    setup,
    "UPDATE c SET v = 's' FROM t WHERE t.id = c.tid RETURNING t.*, name, c.v",
  );
  parity(
    "UPDATE ... FROM alias RETURNING the whole row, old and new",
    setup,
    "UPDATE c SET v = 'w' FROM t x WHERE x.id = c.tid RETURNING x, x.name, old.v AS was, new.v AS now",
  );
  parity(
    "UPDATE ... FROM subquery RETURNING its columns",
    setup,
    "UPDATE c SET v = 'u' FROM (SELECT id, upper(name) AS nm FROM t) s WHERE s.id = c.tid RETURNING s.nm, c.tid",
  );
  parity(
    "UPDATE ... FROM a join RETURNING columns of both sides",
    setup,
    "UPDATE c SET v = 'u' FROM t JOIN (VALUES (1, 'one')) w(k, label) ON w.k = t.id WHERE t.id = c.tid RETURNING label, t.name, c.*",
  );
  queryErrorParity(
    "an ambiguous bare column in RETURNING",
    setup,
    "UPDATE c SET v = 's' FROM t WHERE t.id = c.tid RETURNING id",
  );
  parity(
    "DELETE ... USING RETURNING t.name, c.*",
    setup,
    "DELETE FROM c USING t WHERE t.id = c.tid RETURNING t.name, c.*",
  );
  parity("DELETE ... USING RETURNING *", setup, "DELETE FROM c USING t WHERE t.id = c.tid RETURNING *");
  sequenceParity(
    "DELETE ... USING RETURNING leaves the unmatched rows",
    setup,
    [
      { sql: "DELETE FROM c USING t WHERE t.id = c.tid AND t.id = 1 RETURNING t.name, c.id", query: true },
      { sql: "SELECT id FROM c ORDER BY id", query: true },
    ],
    { compareFinalState: true },
  );
});

describe("#728 ON CONFLICT inference against expression unique indexes", () => {
  const setup = [
    "CREATE TABLE u (id serial, name text, a int, active bool DEFAULT true)",
    "CREATE UNIQUE INDEX u_lower ON u (lower(name))",
  ];
  sequenceParity(
    "DO NOTHING and DO UPDATE through lower(name)",
    setup,
    [
      { sql: "INSERT INTO u (name) VALUES ('a') ON CONFLICT (lower(name)) DO NOTHING" },
      { sql: "INSERT INTO u (name) VALUES ('A') ON CONFLICT (lower(name)) DO NOTHING" },
      {
        sql: "INSERT INTO u (name) VALUES ('A') ON CONFLICT (lower(name)) DO UPDATE SET name = excluded.name RETURNING *",
        query: true,
      },
      {
        sql: "INSERT INTO u (name) VALUES ('B') ON CONFLICT ((lower(name))) DO UPDATE SET name = excluded.name RETURNING name",
        query: true,
      },
      {
        sql: "INSERT INTO u (name) VALUES ('b') ON CONFLICT (lower(u.name)) DO UPDATE SET name = excluded.name RETURNING name",
        query: true,
      },
      { sql: "SELECT id, name FROM u ORDER BY id", query: true },
    ],
    { compareFinalState: true },
  );
  errorParity(
    "no index on upper(name)",
    setup,
    "INSERT INTO u (name) VALUES ('x') ON CONFLICT (upper(name)) DO NOTHING",
  );
  errorParity(
    "a plain column is not the expression",
    setup,
    "INSERT INTO u (name) VALUES ('x') ON CONFLICT (name) DO NOTHING",
  );
  errorParity(
    "an extra element matches no index",
    setup,
    "INSERT INTO u (name) VALUES ('x') ON CONFLICT (lower(name), id) DO NOTHING",
  );
  sequenceParity(
    "a mixed column + expression index, in either order",
    [...setup, "CREATE UNIQUE INDEX u_mixed ON u (a, lower(name))"],
    [
      { sql: "INSERT INTO u (name, a) VALUES ('m', 1) ON CONFLICT (a, lower(name)) DO NOTHING" },
      {
        sql: "INSERT INTO u (name, a) VALUES ('M', 1) ON CONFLICT (lower(name), a) DO UPDATE SET a = 2 RETURNING name, a",
        query: true,
      },
    ],
    { compareFinalState: true },
  );
  const partial = [...setup, "CREATE UNIQUE INDEX u_partial ON u (a) WHERE active"];
  errorParity(
    "a partial index needs its predicate",
    partial,
    "INSERT INTO u (name, a) VALUES ('p', 5) ON CONFLICT (a) DO NOTHING",
  );
  errorParity(
    "a WHERE that does not imply the predicate",
    partial,
    "INSERT INTO u (name, a) VALUES ('p', 5) ON CONFLICT (a) WHERE a > 0 DO NOTHING",
  );
  sequenceParity(
    "a partial index inferred by its predicate",
    partial,
    [
      { sql: "INSERT INTO u (name, a) VALUES ('p', 5) ON CONFLICT (a) WHERE active DO NOTHING" },
      {
        sql: "INSERT INTO u (name, a) VALUES ('q', 5) ON CONFLICT (a) WHERE active DO UPDATE SET name = excluded.name RETURNING name, a",
        query: true,
      },
      {
        sql: "INSERT INTO u (name, a) VALUES ('r', 5) ON CONFLICT (a) WHERE active AND a > 0 DO UPDATE SET name = excluded.name RETURNING name, a",
        query: true,
      },
    ],
    { compareFinalState: true },
  );
});

describe("#728 transaction modes without commas", () => {
  sequenceParity(
    "BEGIN / START TRANSACTION / SET TRANSACTION / SET SESSION CHARACTERISTICS",
    [],
    [
      { sql: "BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE" },
      { sql: "SHOW transaction_isolation", query: true },
      { sql: "SHOW transaction_read_only", query: true },
      { sql: "SHOW transaction_deferrable", query: true },
      { sql: "COMMIT" },
      { sql: "START TRANSACTION ISOLATION LEVEL REPEATABLE READ READ WRITE NOT DEFERRABLE" },
      { sql: "SHOW transaction_isolation", query: true },
      { sql: "SET TRANSACTION ISOLATION LEVEL READ COMMITTED READ ONLY" },
      { sql: "SHOW transaction_isolation", query: true },
      { sql: "SHOW transaction_read_only", query: true },
      { sql: "COMMIT" },
      { sql: "BEGIN READ ONLY ISOLATION LEVEL SERIALIZABLE" },
      { sql: "SHOW transaction_isolation", query: true },
      { sql: "COMMIT" },
      { sql: "BEGIN ISOLATION LEVEL READ UNCOMMITTED, READ WRITE" },
      { sql: "SHOW transaction_isolation", query: true },
      { sql: "ROLLBACK" },
      // READ WRITE: a read-only session default would outlive the test on the shared oracle
      { sql: "SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE READ WRITE NOT DEFERRABLE" },
      { sql: "SHOW default_transaction_isolation", query: true },
      { sql: "SHOW default_transaction_read_only", query: true },
      { sql: "SHOW default_transaction_deferrable", query: true },
      { sql: "RESET default_transaction_isolation" },
    ],
  );
  // both reject it as a syntax error; the engine's message adds what it expected
  matrixBoth("READ alone is not an isolation level", async (memory, postgres) => {
    const a = await memory.exec("BEGIN ISOLATION LEVEL READ ONLY");
    const b = await postgres.exec("BEGIN ISOLATION LEVEL READ ONLY");
    expect(a.error?.sqlstate).toBe("42601");
    expect(b.error?.sqlstate).toBe("42601");
  });
});

describe("#728 ALTER INDEX SET / RESET storage parameters", () => {
  const setup = ["CREATE TABLE q (a int, b text, j jsonb)", "CREATE INDEX i ON q (a)"];
  const reloptions = "SELECT reloptions::text FROM pg_class WHERE relname = 'i'";
  sequenceParity(
    "SET and RESET show in pg_class.reloptions and pg_get_indexdef",
    setup,
    [
      { sql: "ALTER INDEX i SET (fillfactor = 80)" },
      { sql: reloptions, query: true },
      { sql: "SELECT pg_get_indexdef('i'::regclass)", query: true },
      { sql: "ALTER INDEX i SET (deduplicate_items = off, fillfactor = 70)" },
      { sql: reloptions, query: true },
      { sql: "ALTER INDEX i SET (FillFactor = 81)" },
      { sql: reloptions, query: true },
      { sql: "ALTER INDEX i RESET (fillfactor)" },
      { sql: reloptions, query: true },
      { sql: "ALTER INDEX i RESET (deduplicate_items, foo)" },
      { sql: reloptions, query: true },
      { sql: "ALTER INDEX i SET (fillfactor = '75', deduplicate_items = 'TRUE')" },
      { sql: reloptions, query: true },
      { sql: "ALTER INDEX IF EXISTS nope SET (fillfactor = 50)" },
      { sql: "CREATE INDEX i2 ON q (a) WITH (fillfactor = 60)" },
      { sql: "SELECT reloptions::text FROM pg_class WHERE relname = 'i2'", query: true },
      { sql: "CREATE INDEX i4 ON q USING gin (j) WITH (fastupdate = off)" },
      { sql: "ALTER INDEX i4 SET (gin_pending_list_limit = 128)" },
      { sql: "SELECT reloptions::text FROM pg_class WHERE relname = 'i4'", query: true },
    ],
    { compareFinalState: true },
  );
  errorParity("an unrecognized parameter", setup, "ALTER INDEX i SET (foo = 1)");
  errorParity("fillfactor below its bounds", setup, "ALTER INDEX i SET (fillfactor = 5)");
  errorParity("fillfactor above its bounds", setup, "ALTER INDEX i SET (fillfactor = 101)");
  errorParity("a non-integer fillfactor", setup, "ALTER INDEX i SET (fillfactor = 'abc')");
  errorParity("a bare integer parameter", setup, "ALTER INDEX i SET (fillfactor)");
  errorParity("a non-boolean deduplicate_items", setup, "ALTER INDEX i SET (deduplicate_items = maybe)");
  errorParity("a parameter twice", setup, "ALTER INDEX i SET (fillfactor = 50, fillfactor = 60)");
  errorParity("RESET with a value", setup, "ALTER INDEX i RESET (fillfactor = 3)");
  errorParity("a missing index", setup, "ALTER INDEX nope SET (fillfactor = 50)");
  errorParity("a table is not an index", setup, "ALTER INDEX q SET (fillfactor = 50)");
  errorParity(
    "gin takes no fillfactor",
    [...setup, "CREATE INDEX i4 ON q USING gin (j)"],
    "ALTER INDEX i4 SET (fillfactor = 50)",
  );
  errorParity("CREATE INDEX checks its parameters too", setup, "CREATE INDEX i3 ON q (a) WITH (foo = 1)");
  errorParity("an enum parameter", setup, "CREATE INDEX i6 ON q USING gist (a) WITH (buffering = maybe)");
});

describe("#728 WITH RECURSIVE ... SEARCH / CYCLE", () => {
  parityTyped(
    "SEARCH DEPTH FIRST",
    [],
    "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 3) SEARCH DEPTH FIRST BY n SET ord SELECT * FROM r",
  );
  parityTyped(
    "SEARCH BREADTH FIRST",
    [],
    "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 3) SEARCH BREADTH FIRST BY n SET ord SELECT * FROM r",
  );
  parityTyped(
    "CYCLE with the boolean mark",
    [],
    "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n % 2 + 1 FROM r) CYCLE n SET is_cycle USING path SELECT * FROM r",
  );
  parityTyped(
    "CYCLE ... TO 'Y' DEFAULT 'N'",
    [],
    "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n % 2 + 1 FROM r) CYCLE n SET is_cycle TO 'Y' DEFAULT 'N' USING path SELECT * FROM r",
  );
  parityTyped(
    "CYCLE ... TO 1 DEFAULT 0",
    [],
    "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n % 2 + 1 FROM r) CYCLE n SET is_cycle TO 1 DEFAULT 0 USING path SELECT * FROM r",
  );
  parityTyped(
    "SEARCH and CYCLE together",
    [],
    "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 3) SEARCH DEPTH FIRST BY n SET ord CYCLE n SET c USING p SELECT * FROM r",
  );
  parityTyped(
    "UNION (distinct) with SEARCH",
    [],
    "WITH RECURSIVE r(n) AS (SELECT 1 UNION SELECT n + 1 FROM r WHERE n < 3) SEARCH DEPTH FIRST BY n SET ord SELECT * FROM r",
  );
  parity(
    "depth-first ordering over two columns",
    [],
    "WITH RECURSIVE t(a, b) AS (VALUES (1, 'x') UNION ALL SELECT a + 1, b || 'y' FROM t WHERE a < 3) SEARCH DEPTH FIRST BY b, a SET ord SELECT * FROM t ORDER BY ord",
  );
  parity(
    "breadth-first ordering over two columns",
    [],
    "WITH RECURSIVE t(a, b) AS (VALUES (1, 'x') UNION ALL SELECT a + 1, b || 'y' FROM t WHERE a < 3) SEARCH BREADTH FIRST BY b, a SET ord SELECT * FROM t ORDER BY ord",
  );
  parity(
    "a graph walk stops at the cycle (join in the recursive term)",
    ["CREATE TABLE edges (id int, parent int)", "INSERT INTO edges VALUES (2, 1), (3, 1), (4, 2), (1, 4)"],
    "WITH RECURSIVE g(id, parent) AS (SELECT 1, NULL::int UNION ALL SELECT e.id, e.parent FROM edges e JOIN g ON g.id = e.parent) CYCLE id SET looped USING trail SELECT * FROM g ORDER BY trail::text",
  );
  parity(
    "a tree walk in depth-first order",
    [
      "CREATE TABLE tree (id int, parent int, label text)",
      "INSERT INTO tree VALUES (1, NULL, 'root'), (2, 1, 'b'), (3, 1, 'a'), (4, 2, 'c'), (5, 3, 'd')",
    ],
    "WITH RECURSIVE w AS (SELECT id, label FROM tree WHERE parent IS NULL UNION ALL SELECT tree.id, tree.label FROM tree, w WHERE tree.parent = w.id) SEARCH DEPTH FIRST BY label SET ord SELECT id, label FROM w ORDER BY ord",
  );
  queryErrorParity(
    "SEARCH on a non-recursive WITH",
    [],
    "WITH r(n) AS (SELECT 1) SEARCH DEPTH FIRST BY n SET ord SELECT * FROM r",
  );
  queryErrorParity(
    "an unknown search column",
    [],
    "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 3) SEARCH DEPTH FIRST BY x SET ord SELECT * FROM r",
  );
  queryErrorParity(
    "a search column twice",
    [],
    "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 3) SEARCH DEPTH FIRST BY n, n SET ord SELECT * FROM r",
  );
  queryErrorParity(
    "the mark and path columns named alike",
    [],
    "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 3) CYCLE n SET c USING c SELECT * FROM r",
  );
  queryErrorParity(
    "a sequence column named like a WITH column",
    [],
    "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 3) SEARCH DEPTH FIRST BY n SET n SELECT * FROM r",
  );
  queryErrorParity(
    "TO and DEFAULT of different types",
    [],
    "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 3) CYCLE n SET c TO 1 DEFAULT 'x' USING p SELECT * FROM r",
  );
  queryErrorParity(
    "the recursive reference inside a subquery",
    [],
    "WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM (SELECT * FROM r) s WHERE n < 3) SEARCH DEPTH FIRST BY n SET ord SELECT * FROM r",
  );
});

describe("#728 TABLESAMPLE", () => {
  const setup = ["CREATE TABLE ts AS SELECT g AS id FROM generate_series(1, 200) g"];
  parity("SYSTEM (100)", setup, "SELECT count(*)::int AS n FROM ts TABLESAMPLE SYSTEM (100)");
  parity("BERNOULLI (100)", setup, "SELECT count(*)::int AS n FROM ts TABLESAMPLE BERNOULLI (100)");
  parity("SYSTEM (0)", setup, "SELECT count(*)::int AS n FROM ts TABLESAMPLE SYSTEM (0)");
  parity(
    "BERNOULLI (0) REPEATABLE",
    setup,
    "SELECT count(*)::int AS n FROM ts TABLESAMPLE BERNOULLI (0) REPEATABLE (42)",
  );
  parity("SYSTEM (100) REPEATABLE", setup, "SELECT count(*)::int AS n FROM ts TABLESAMPLE SYSTEM (100) REPEATABLE (7)");
  queryErrorParity("a percentage above 100", setup, "SELECT count(*) FROM ts TABLESAMPLE BERNOULLI (101)");
  queryErrorParity("an unknown sampling method", setup, "SELECT count(*) FROM ts TABLESAMPLE foo (10)");
});
