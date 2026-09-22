import { parity, sequenceParity } from "../helpers.ts";

parity(
  "multi-row INSERT SELECT copies ordered source rows",
  [
    "CREATE TABLE src(id INTEGER,v TEXT)",
    "CREATE TABLE dst(id INTEGER,v TEXT)",
    "INSERT INTO src VALUES (2,'b'),(1,'a'),(3,'c')",
    "INSERT INTO dst SELECT id,v FROM src ORDER BY id",
  ],
  "SELECT * FROM dst ORDER BY rowid",
);
parity(
  "INSERT SELECT can project expressions",
  [
    "CREATE TABLE src(v INTEGER)",
    "CREATE TABLE dst(v INTEGER)",
    "INSERT INTO src VALUES (1),(2)",
    "INSERT INTO dst SELECT v*10 FROM src",
  ],
  "SELECT * FROM dst ORDER BY v",
);
parity(
  "INSERT OR IGNORE skips one conflicting source row",
  [
    "CREATE TABLE t(id INTEGER UNIQUE,v TEXT)",
    "INSERT INTO t VALUES (1,'old')",
    "INSERT OR IGNORE INTO t VALUES (1,'new'),(2,'two')",
  ],
  "SELECT * FROM t ORDER BY id",
);
sequenceParity(
  "INSERT OR IGNORE leaves table usable",
  ["CREATE TABLE t(id INTEGER UNIQUE)"],
  [
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "INSERT OR IGNORE INTO t VALUES (1)" },
    { sql: "INSERT INTO t VALUES (2)" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
);
parity(
  "INSERT SELECT with column list fills default",
  [
    "CREATE TABLE src(id INTEGER)",
    "CREATE TABLE dst(id INTEGER,label TEXT DEFAULT 'copied')",
    "INSERT INTO src VALUES (1),(2)",
    "INSERT INTO dst(id) SELECT id FROM src",
  ],
  "SELECT * FROM dst ORDER BY id",
);
