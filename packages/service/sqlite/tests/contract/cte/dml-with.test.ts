import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "WITH drives INSERT VALUES expressions",
  ["CREATE TABLE t(v INTEGER)"],
  [
    { sql: "WITH c(x) AS (VALUES(7)) INSERT INTO t VALUES ((SELECT x FROM c))" },
    { sql: "SELECT v FROM t", query: true },
  ],
);

sequenceParity(
  "WITH drives UPDATE",
  ["CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER)", "INSERT INTO t VALUES (1,0),(2,0)"],
  [
    { sql: "WITH c(x) AS (VALUES(9)) UPDATE t SET v=(SELECT x FROM c) WHERE id=2" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
);

sequenceParity(
  "WITH drives DELETE",
  ["CREATE TABLE t(id INTEGER PRIMARY KEY)", "INSERT INTO t VALUES (1),(2),(3)"],
  [
    { sql: "WITH c(x) AS (VALUES(2)) DELETE FROM t WHERE id=(SELECT x FROM c)" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
);
