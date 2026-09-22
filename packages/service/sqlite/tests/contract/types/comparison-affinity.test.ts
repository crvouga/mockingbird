import { parity } from "../helpers.ts";

parity("bare values have no comparison affinity", [], "SELECT 1 = '1' AS equal");

parity(
  "INTEGER affinity converts numeric text for comparison",
  ["CREATE TABLE t(i INTEGER)", "INSERT INTO t VALUES (1)"],
  "SELECT i = '1' AS integer_text, i = '1.0' AS real_text FROM t",
);

parity(
  "TEXT affinity converts numeric expressions for comparison",
  ["CREATE TABLE t(v TEXT)", "INSERT INTO t VALUES ('1')"],
  "SELECT v = 1 AS equal FROM t",
);

parity(
  "WHERE applies column comparison affinity",
  ["CREATE TABLE t(i INTEGER)", "INSERT INTO t VALUES (1),(2)"],
  "SELECT i FROM t WHERE i = '1'",
);

parity(
  "NUMERIC comparison affinity preserves nonnumeric and numeric edges",
  ["CREATE TABLE t(v NUMERIC)", "INSERT INTO t VALUES (1),(1.5),('x')"],
  "SELECT v, v = '01' AS leading, v = '1.5' AS fractional, v = 'x' AS text FROM t ORDER BY rowid",
);

parity(
  "IN applies left column affinity",
  ["CREATE TABLE t(i INTEGER)", "INSERT INTO t VALUES (1),(2)"],
  "SELECT i, i IN ('1','3') AS matched FROM t ORDER BY i",
);
