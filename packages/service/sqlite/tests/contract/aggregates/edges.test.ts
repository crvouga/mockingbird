import { parity } from "../helpers.ts";

const data = ["CREATE TABLE t(g TEXT,v INTEGER)", "INSERT INTO t VALUES ('a',1),('a',1),('a',2),('b',NULL),('b',3)"];
parity("COUNT DISTINCT ignores duplicates and NULL", data, "SELECT count(DISTINCT v) n FROM t");
parity(
  "aggregate FILTER selects qualifying rows",
  data,
  "SELECT count(*) FILTER (WHERE v>1) n,sum(v) FILTER (WHERE g='a') s FROM t",
);
parity(
  "grouped DISTINCT aggregate evaluates per group",
  data,
  "SELECT g,count(DISTINCT v) n FROM t GROUP BY g ORDER BY g",
);
parity(
  "empty table aggregates preserve identities",
  ["CREATE TABLE t(v INTEGER)"],
  "SELECT count(v) c,sum(v) s,total(v) t,avg(v) a,min(v) mi,max(v) ma FROM t",
);
parity(
  "TOTAL returns zero while SUM returns NULL for all NULL",
  ["CREATE TABLE t(v INTEGER)", "INSERT INTO t VALUES (NULL),(NULL)"],
  "SELECT sum(v) s,total(v) t FROM t",
);
