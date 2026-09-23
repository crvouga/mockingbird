import { parity } from "../helpers.ts";

parity("math trig and constants", [], "SELECT sin(0) s, cos(0) c, tan(0) t, pi() > 3 AS p, degrees(radians(90)) d");
parity(
  "math logs and pow",
  [],
  "SELECT ln(1) a, log(100) b, log(10,100) c, pow(2,3) d, power(2,4) e, sqrt(9) f, mod(10,3) g",
);
parity(
  "math rounding",
  [],
  "SELECT floor(1.5) a, ceil(1.2) b, ceiling(1.2) c, trunc(1.9) d, sign(-3) e, sign(0) f, sign(2) g",
);
parity(
  "string builtins",
  [],
  "SELECT instr('abc','b') a, char(65,66) b, concat('a','b') c, concat_ws('-','a','b') d, unicode('A') e, octet_length('ab') f",
);
parity("like and glob functions", [], "SELECT like('a%','abc') a, glob('a*','abc') b, format('%s','x') c");
parity(
  "iif and likelihood family",
  [],
  "SELECT iif(1,'y','n') a, if(0,'y','n') b, likely(7) c, unlikely(0) d, likelihood(3,0.5) e",
);
parity("unhex and hex roundtrip", [], "SELECT hex(unhex('4142')) a, typeof(unhex('41')) b");
parity(
  "compile options and source",
  [],
  "SELECT sqlite_compileoption_used('ENABLE_FTS5') a, length(sqlite_source_id()) > 10 AS b",
);
parity(
  "total_changes after insert",
  ["CREATE TABLE t(x)", "INSERT INTO t VALUES (1),(2)"],
  "SELECT total_changes() >= 2 AS ok",
);
parity(
  "string_agg",
  ["CREATE TABLE t(x TEXT)", "INSERT INTO t VALUES ('a'),('b'),('c')"],
  "SELECT string_agg(x, ',') AS s FROM t",
);
parity(
  "window ntile cume_dist percent_rank",
  ["CREATE TABLE t(x INT)", "INSERT INTO t VALUES (1),(2),(3),(4)"],
  "SELECT x, ntile(2) OVER (ORDER BY x) AS n, cume_dist() OVER (ORDER BY x) AS c, percent_rank() OVER (ORDER BY x) AS p FROM t ORDER BY x",
);
