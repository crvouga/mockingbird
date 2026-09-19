import { parity, sequenceParity } from "../helpers.ts";

parity(
  "scalar min and max compare mixed arguments",
  [],
  "SELECT min(3,1,2) lo,max(3,1,2) hi,min('b','a','c') tlo,max('b','a','c') thi",
);
parity("scalar min and max return NULL when any argument is NULL", [], "SELECT min(1,NULL,3) a,max(1,NULL,3) b");
parity("substring is an alias of substr", [], "SELECT substring('abcdef',2,3) a,substring('abcdef',-2) b");
parity(
  "zeroblob allocates a zero-filled blob",
  [],
  "SELECT typeof(zeroblob(4)) t,length(zeroblob(4)) n,hex(zeroblob(4)) h,zeroblob(0) empty",
);

sequenceParity(
  "changes reports rows affected by the previous write",
  ["CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)"],
  [
    { sql: "INSERT INTO t(name) VALUES ('a'),('b'),('c')" },
    { sql: "SELECT changes() AS n", query: true },
    { sql: "UPDATE t SET name='x' WHERE id<=2" },
    { sql: "SELECT changes() AS n", query: true },
    { sql: "DELETE FROM t WHERE id=3" },
    { sql: "SELECT changes() AS n", query: true },
  ],
);

parity(
  "group_concat skips NULL inputs",
  ["CREATE TABLE t(g TEXT, v INTEGER)", "INSERT INTO t VALUES ('a',1),('a',NULL),('a',2),('b',NULL)"],
  "SELECT g, group_concat(v) c, group_concat(v,'|') d FROM t GROUP BY g ORDER BY g",
);

parity("group_concat over empty table is NULL", ["CREATE TABLE t(v INTEGER)"], "SELECT group_concat(v) c FROM t");
