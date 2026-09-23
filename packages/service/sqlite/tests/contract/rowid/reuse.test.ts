import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "plain INTEGER PRIMARY KEY reuses deleted maximum rowid",
  ["CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)", "INSERT INTO t(v) VALUES ('a'),('b'),('c')"],
  [
    { sql: "DELETE FROM t WHERE id=3" },
    { sql: "INSERT INTO t(v) VALUES ('reused')" },
    { sql: "SELECT id,v FROM t ORDER BY id", query: true },
  ],
);

sequenceParity(
  "AUTOINCREMENT does not reuse deleted maximum rowid",
  ["CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)", "INSERT INTO t(v) VALUES ('a'),('b'),('c')"],
  [
    { sql: "DELETE FROM t WHERE id=3" },
    { sql: "INSERT INTO t(v) VALUES ('next')" },
    { sql: "SELECT id,v FROM t ORDER BY id", query: true },
  ],
);
