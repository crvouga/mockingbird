import { parity } from "../helpers.ts";

const data = [
  "CREATE TABLE t(id INTEGER,v INTEGER,name TEXT)",
  "INSERT INTO t VALUES (1,2,'b'),(2,NULL,'z'),(3,1,'c'),(4,2,'a')",
];

parity("ORDER BY ASC places NULL first by default", data, "SELECT id,v FROM t ORDER BY v ASC,id");
parity("ORDER BY DESC places NULL last by default", data, "SELECT id,v FROM t ORDER BY v DESC,id");
parity("multiple sort keys resolve ties", data, "SELECT id,v,name FROM t ORDER BY v ASC,name DESC");
parity("explicit NULLS FIRST and LAST", data, "SELECT id,v FROM t ORDER BY v ASC NULLS LAST,id");
parity("ORDER BY output alias and ordinal", data, "SELECT name AS label,id FROM t ORDER BY 1 DESC,2 ASC");
