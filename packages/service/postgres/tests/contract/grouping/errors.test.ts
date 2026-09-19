import { queryErrorParity } from "../helpers.ts";

const t = ["CREATE TABLE t (a int, b int, c int)", "INSERT INTO t VALUES (1, 2, 3), (1, 4, 5), (2, 6, 7)"];

queryErrorParity("group by ordinal out of range", t, "SELECT a FROM t GROUP BY 5", undefined);
queryErrorParity("undefined column in group by", t, "SELECT count(*) FROM t GROUP BY zz", "undefined_column");
queryErrorParity(
  "undefined column in having",
  t,
  "SELECT a, count(*) FROM t GROUP BY a HAVING zz > 1",
  "undefined_column",
);
