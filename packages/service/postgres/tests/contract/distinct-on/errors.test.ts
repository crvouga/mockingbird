import { queryErrorParity } from "../helpers.ts";

const t = ["CREATE TABLE t (a int, b int)", "INSERT INTO t VALUES (1, 2), (1, 3), (2, 4)"];

queryErrorParity("distinct on undefined column", t, "SELECT DISTINCT ON (zz) a FROM t ORDER BY zz", "undefined_column");
queryErrorParity(
  "distinct on undefined column in select",
  t,
  "SELECT DISTINCT ON (a) zz FROM t ORDER BY a",
  "undefined_column",
);
