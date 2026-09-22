import { parity, queryErrorParity } from "../helpers.ts";

parity("generate_series basic", [], "SELECT * FROM generate_series(1, 5) AS g(v) ORDER BY v");
parity("generate_series with step", [], "SELECT * FROM generate_series(0, 10, 3) AS g(v) ORDER BY v");
parity("generate_series negative step", [], "SELECT * FROM generate_series(5, 1, -1) AS g(v) ORDER BY v");
parity("generate_series empty when start beyond stop", [], "SELECT * FROM generate_series(5, 1) AS g(v)");
parity("generate_series single value", [], "SELECT * FROM generate_series(7, 7) AS g(v)");
parity("generate_series default column name", [], "SELECT generate_series FROM generate_series(1, 3) ORDER BY 1");
parity(
  "generate_series bigint",
  [],
  "SELECT * FROM generate_series(4000000000::bigint, 4000000002::bigint) AS g(v) ORDER BY v",
);
parity("generate_series negative range", [], "SELECT * FROM generate_series(-3, -1) AS g(v) ORDER BY v");
parity(
  "generate_series timestamp",
  [],
  "SELECT * FROM generate_series('2024-01-01'::timestamp, '2024-01-04'::timestamp, interval '1 day') AS g(t) ORDER BY t",
);
parity(
  "generate_series timestamp hourly",
  [],
  "SELECT * FROM generate_series('2024-06-01 00:00'::timestamp, '2024-06-01 06:00'::timestamp, interval '2 hours') AS g(t) ORDER BY t",
);
parity(
  "generate_series joined to table",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a'), (3, 'c')"],
  "SELECT g.v AS n, t.v AS label FROM generate_series(1, 3) AS g(v) LEFT JOIN t ON t.id = g.v ORDER BY n",
);
parity("generate_series aggregated", [], "SELECT sum(v) AS s, count(*) AS n FROM generate_series(1, 100) AS g(v)");
parity(
  "two series cross join",
  [],
  "SELECT a.v AS x, b.v AS y FROM generate_series(1, 2) a(v), generate_series(1, 2) b(v) ORDER BY x, y",
);
parity("generate_series in where subquery", [], "SELECT 5 IN (SELECT * FROM generate_series(1, 10)) AS found");

queryErrorParity(
  "generate_series zero step",
  [],
  "SELECT * FROM generate_series(1, 5, 0) AS g(v)",
  "invalid_parameter",
);
