import { parity } from "../helpers.ts";

parity("float literal 1.0 has real typeof", [], "SELECT typeof(1.0) t, typeof(1) i");
parity("unary minus of float literal stays real", [], "SELECT typeof(-0.0) t, typeof(-1.0) u, typeof(+1.0) p");
parity("CAST to REAL preserves real typeof for integers", [], "SELECT typeof(CAST(1 AS REAL)) t, CAST(1 AS REAL) v");
parity("CAST text 1.0 AS REAL is real", [], "SELECT typeof(CAST('1.0' AS REAL)) t");
parity(
  "aggregate column names include arguments",
  ["CREATE TABLE t(v INTEGER)", "INSERT INTO t VALUES (1),(2)"],
  "SELECT sum(v) AS s, typeof(sum(v)) AS kind FROM t",
);
