import { parity } from "../helpers.ts";

const data = [
  "CREATE TABLE t(a INTEGER,b TEXT)",
  "INSERT INTO t VALUES (1,'x'),(1,'x'),(1,'y'),(2,'x'),(NULL,'n'),(NULL,'n')",
];

parity("DISTINCT removes duplicate rows", data, "SELECT DISTINCT a,b FROM t ORDER BY a,b");
parity("DISTINCT applies to complete projection", data, "SELECT DISTINCT a FROM t ORDER BY a");
parity("DISTINCT treats NULL values as duplicates", data, "SELECT DISTINCT a FROM t WHERE a IS NULL");
parity("DISTINCT aggregate removes duplicate inputs", data, "SELECT count(DISTINCT a) n,sum(DISTINCT a) s FROM t");
