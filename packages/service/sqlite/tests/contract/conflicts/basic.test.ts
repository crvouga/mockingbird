import { parity, sequenceParity } from "../helpers.ts";

const data = ["CREATE TABLE t(id INTEGER PRIMARY KEY,value TEXT UNIQUE)", "INSERT INTO t VALUES (1,'a'),(2,'b')"];

sequenceParity("INSERT OR IGNORE skips conflicting row", data, [
  { sql: "INSERT OR IGNORE INTO t VALUES (3,'a')" },
  { sql: "SELECT * FROM t ORDER BY id", query: true },
]);
parity(
  "INSERT OR REPLACE replaces unique conflict",
  [...data, "INSERT OR REPLACE INTO t VALUES (3,'a')"],
  "SELECT * FROM t ORDER BY id",
);
parity(
  "OR REPLACE updates primary-key row",
  [...data, "INSERT OR REPLACE INTO t VALUES (1,'new')"],
  "SELECT * FROM t ORDER BY id",
);
parity(
  "REPLACE INTO is a synonym for INSERT OR REPLACE",
  [...data, "REPLACE INTO t VALUES (3,'a')"],
  "SELECT * FROM t ORDER BY id",
);
parity(
  "REPLACE INTO updates primary-key row",
  [...data, "REPLACE INTO t VALUES (1,'new')"],
  "SELECT * FROM t ORDER BY id",
);
parity(
  "multi-row OR IGNORE keeps nonconflicting rows",
  [...data, "INSERT OR IGNORE INTO t VALUES (3,'a'),(4,'d'),(2,'x')"],
  "SELECT * FROM t ORDER BY id",
);
