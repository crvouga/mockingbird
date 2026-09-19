import { parity } from "../helpers.ts";

parity(
  "IN returns NULL when only unknown comparisons remain",
  [],
  "SELECT 2 IN (1,NULL) a,1 IN (1,NULL) b,NULL IN (1,2) c",
);
parity(
  "NOT IN propagates NULL from its list",
  [],
  "SELECT 2 NOT IN (1,NULL) a,1 NOT IN (1,NULL) b,NULL NOT IN (1,2) c",
);
parity(
  "IN with NULL filters unknown rows",
  ["CREATE TABLE t(v INTEGER)", "INSERT INTO t VALUES (1),(2),(NULL)"],
  "SELECT v FROM t WHERE v IN (1,NULL) ORDER BY v",
);
parity(
  "aggregates over all NULL inputs follow SQLite",
  ["CREATE TABLE t(v INTEGER)", "INSERT INTO t VALUES (NULL),(NULL)"],
  "SELECT count(v) c,sum(v) s,avg(v) a,total(v) t,min(v) mi,max(v) ma FROM t",
);
parity(
  "COALESCE selects the first non-null expression",
  [],
  "SELECT coalesce(NULL,NULL,3,4) a,coalesce(NULL,'x',NULL) b,coalesce(0,9) c",
);
