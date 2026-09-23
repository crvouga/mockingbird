import { parity } from "../helpers.ts";

parity(
  "bytea equality",
  [],
  "SELECT '\\x6162'::bytea = '\\x6162'::bytea AS a, '\\x6162'::bytea = '\\x6163'::bytea AS b",
);
parity("bytea inequality", [], "SELECT '\\x6162'::bytea <> '\\x6163'::bytea AS v");
parity(
  "bytea less than by bytes",
  [],
  "SELECT '\\x00'::bytea < '\\x01'::bytea AS a, '\\xfe'::bytea < '\\xff'::bytea AS b",
);
parity("bytea prefix ordering", [], "SELECT '\\x61'::bytea < '\\x6161'::bytea AS v");
parity(
  "bytea comparison operators",
  [],
  "SELECT '\\x02'::bytea > '\\x01'::bytea AS a, '\\x01'::bytea <= '\\x01'::bytea AS b",
);
parity(
  "order by bytea",
  ["CREATE TABLE t (v bytea)", "INSERT INTO t VALUES ('\\xff'), ('\\x00'), ('\\x0100'), ('\\x01'), ('\\x')"],
  "SELECT v FROM t ORDER BY v",
);
parity(
  "bytea distinct and group",
  ["CREATE TABLE t (v bytea)", "INSERT INTO t VALUES ('\\x01'), ('\\x01'), ('\\x02')"],
  "SELECT v, count(*) AS n FROM t GROUP BY v ORDER BY v",
);
parity(
  "min max of bytea",
  ["CREATE TABLE t (v bytea)", "INSERT INTO t VALUES ('\\x05'), ('\\x01'), ('\\xff')"],
  "SELECT min(v) AS lo, max(v) AS hi FROM t",
);
