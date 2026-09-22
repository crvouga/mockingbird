import { parity, queryErrorParity } from "../helpers.ts";

const t = ["CREATE TABLE t (id int, v int)", "INSERT INTO t VALUES (1, 10), (2, 20), (3, 30)"];

// MATERIALIZED / NOT MATERIALIZED hints (results must be identical either way)
parity("cte materialized", t, "WITH s AS MATERIALIZED (SELECT id, v FROM t WHERE v > 10) SELECT id FROM s ORDER BY id");
parity(
  "cte not materialized",
  t,
  "WITH s AS NOT MATERIALIZED (SELECT id, v FROM t WHERE v > 10) SELECT id FROM s ORDER BY id",
);
parity(
  "materialized cte used twice",
  t,
  "WITH s AS MATERIALIZED (SELECT id, v FROM t) SELECT a.id FROM s a JOIN s b ON a.id = b.id ORDER BY a.id",
);
parity(
  "not materialized cte with outer filter",
  t,
  "WITH s AS NOT MATERIALIZED (SELECT id, v FROM t) SELECT id FROM s WHERE v = 20",
);
parity(
  "materialized with column aliases",
  t,
  "WITH s(a, b) AS MATERIALIZED (SELECT id, v FROM t) SELECT a FROM s WHERE b > 15 ORDER BY a",
);

// errors
queryErrorParity(
  "cte referenced before definition",
  t,
  "WITH a AS (SELECT * FROM b), b AS (SELECT 1 AS x) SELECT * FROM a",
  "undefined_table",
);
queryErrorParity(
  "cte more column aliases than columns",
  t,
  "WITH s(a, b, c) AS (SELECT id, v FROM t) SELECT * FROM s",
  undefined,
);
queryErrorParity("undefined cte reference", t, "WITH s AS (SELECT 1 AS x) SELECT * FROM nothere", "undefined_table");
queryErrorParity(
  "self reference without recursive",
  t,
  "WITH s AS (SELECT id FROM s) SELECT * FROM s",
  "undefined_table",
);
