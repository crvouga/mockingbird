import { expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { errorParity, parity, queryErrorParity, sequenceParity } from "../helpers.ts";

// #692: TABLESAMPLE BERNOULLI / SYSTEM [REPEATABLE] and a data-modifying MERGE inside WITH.

const table = ["CREATE TABLE c AS SELECT g AS a FROM generate_series(1, 1000) g"];

parity(
  "the issue's TABLESAMPLE query",
  ["CREATE TABLE c (a int)"],
  "SELECT count(*) >= 0 AS ok FROM c TABLESAMPLE BERNOULLI (100)",
);
parity(
  "100% and 0% samples are exact",
  table,
  "SELECT (SELECT count(*) FROM c TABLESAMPLE BERNOULLI (100)) AS b100, (SELECT count(*) FROM c TABLESAMPLE BERNOULLI (0)) AS b0, (SELECT count(*) FROM c TABLESAMPLE SYSTEM (100)) AS s100, (SELECT count(*) FROM c TABLESAMPLE SYSTEM (0)) AS s0, (SELECT sum(a) FROM c AS x TABLESAMPLE SYSTEM (100.0) REPEATABLE (7)) AS total",
);
// PostgreSQL's BERNOULLI sampler hashes (page, line, seed); for a table of int4 rows written in
// order the engine's page layout matches, so the REPEATABLE sample is the same rows.
parity(
  "a REPEATABLE Bernoulli sample of a freshly loaded int table matches PostgreSQL's",
  table,
  "SELECT count(*) AS n, sum(a) AS s FROM c TABLESAMPLE BERNOULLI (50) REPEATABLE (1)",
);
parity(
  "a REPEATABLE SYSTEM sample of a freshly loaded int table matches PostgreSQL's",
  table,
  "SELECT count(*) AS n, sum(a) AS s FROM c TABLESAMPLE SYSTEM (40) REPEATABLE (3)",
);
queryErrorParity("percentage above 100", table, "SELECT count(*) FROM c TABLESAMPLE BERNOULLI (101)");
queryErrorParity("negative percentage", table, "SELECT count(*) FROM c TABLESAMPLE SYSTEM (-1)");
queryErrorParity("unknown sampling method", table, "SELECT count(*) FROM c TABLESAMPLE foo (1)", "undefined_object");
queryErrorParity("too many arguments", table, "SELECT count(*) FROM c TABLESAMPLE BERNOULLI (1, 2)");
queryErrorParity("NULL percentage", table, "SELECT count(*) FROM c TABLESAMPLE BERNOULLI (NULL)");
queryErrorParity("NULL seed", table, "SELECT count(*) FROM c TABLESAMPLE BERNOULLI (10) REPEATABLE (NULL)");
queryErrorParity(
  "TABLESAMPLE on a view",
  [...table, "CREATE VIEW v AS SELECT * FROM c"],
  "SELECT count(*) FROM v TABLESAMPLE BERNOULLI (50)",
  "unsupported",
);

test("a REPEATABLE sample is deterministic and a subset; WHERE and joins see only sampled rows", () => {
  const db = new Database();
  db.exec("CREATE TABLE t (id int PRIMARY KEY, v text)");
  db.exec("INSERT INTO t SELECT g, 'v' || g FROM generate_series(1, 500) g");
  const sample = (sql: string) => (db.query(sql) as Array<{ id: number }>).map((r) => r.id);
  const a = sample("SELECT id FROM t TABLESAMPLE BERNOULLI (30) REPEATABLE (42) ORDER BY id");
  const b = sample("SELECT id FROM t TABLESAMPLE BERNOULLI (30) REPEATABLE (42) ORDER BY id");
  expect(a).toEqual(b);
  expect(a.length).toBeGreaterThan(100);
  expect(a.length).toBeLessThan(200);
  const filtered = sample(
    "SELECT id FROM t TABLESAMPLE BERNOULLI (30) REPEATABLE (42) WHERE id = 1 OR id > 0 ORDER BY id",
  );
  expect(filtered).toEqual(a);
  const other = sample("SELECT id FROM t TABLESAMPLE BERNOULLI (30) REPEATABLE (43) ORDER BY id");
  expect(other).not.toEqual(a);
});

const merge = ["CREATE TABLE m (a int PRIMARY KEY, b int)", "INSERT INTO m VALUES (1, 1)"];

sequenceParity(
  "MERGE inside WITH, with RETURNING read by the outer query",
  merge,
  [
    {
      sql: "WITH x AS (MERGE INTO m USING (VALUES (1, 4), (5, 5)) s(a, b) ON m.a = s.a WHEN MATCHED THEN UPDATE SET b = s.b WHEN NOT MATCHED THEN INSERT VALUES (s.a, s.b) RETURNING merge_action() AS action, m.*) SELECT * FROM x ORDER BY a",
      query: true,
    },
    { sql: "SELECT * FROM m ORDER BY a", query: true },
  ],
  { compareFinalState: true },
);
sequenceParity(
  "MERGE inside WITH without RETURNING still runs",
  merge,
  [
    {
      sql: "WITH x AS (MERGE INTO m USING (VALUES (1, 3)) s(a, b) ON m.a = s.a WHEN MATCHED THEN UPDATE SET b = s.b) SELECT 1 AS one",
      query: true,
    },
    { sql: "SELECT * FROM m ORDER BY a", query: true },
  ],
  { compareFinalState: true },
);
errorParity(
  "a failing MERGE inside WITH changes nothing",
  merge,
  "WITH x AS (MERGE INTO m USING (VALUES (1, 3), (1, 4)) s(a, b) ON m.a = s.a WHEN MATCHED THEN UPDATE SET b = s.b RETURNING *) SELECT * FROM x",
  "cardinality",
);
