import { parity } from "../helpers.ts";

const data = ["CREATE TABLE t(g TEXT,v INTEGER)", "INSERT INTO t VALUES ('a',1),('a',2),('a',NULL),('b',5),('b',5)"];

parity(
  "count star and count expression differ on NULL",
  data,
  "SELECT count(*) all_rows,count(v) values_only,count(DISTINCT v) distinct_values FROM t",
);
parity("sum avg and total aggregate numeric values", data, "SELECT sum(v) s,avg(v) a,total(v) t FROM t");
parity("min and max ignore NULL", data, "SELECT min(v) lo,max(v) hi FROM t");
parity(
  "empty aggregate identities follow SQLite",
  ["CREATE TABLE empty(v INTEGER)"],
  "SELECT count(*) c,sum(v) s,avg(v) a,total(v) t,min(v) mi,max(v) ma FROM empty",
);
parity(
  "group_concat supports separator",
  data,
  "SELECT g,group_concat(v) plain,group_concat(v,'|') custom FROM t GROUP BY g ORDER BY g",
);
