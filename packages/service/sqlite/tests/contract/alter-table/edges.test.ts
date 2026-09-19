import { parity, sequenceParity } from "../helpers.ts";

sequenceParity(
  "renamed table accepts later queries",
  ["CREATE TABLE old(id INTEGER,v TEXT)", "INSERT INTO old VALUES (1,'a')"],
  [{ sql: "ALTER TABLE old RENAME TO renamed" }, { sql: "SELECT * FROM renamed", query: true }],
);
sequenceParity(
  "renamed table accepts later inserts",
  ["CREATE TABLE old(id INTEGER)"],
  [
    { sql: "ALTER TABLE old RENAME TO renamed" },
    { sql: "INSERT INTO renamed VALUES (2)" },
    { sql: "SELECT * FROM renamed", query: true },
  ],
);
sequenceParity(
  "added default column fills existing and new rows",
  ["CREATE TABLE t(id INTEGER)", "INSERT INTO t VALUES (1)"],
  [
    { sql: "ALTER TABLE t ADD COLUMN label TEXT DEFAULT 'new'" },
    { sql: "INSERT INTO t(id) VALUES (2)" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
);
parity(
  "explicit value overrides an added column default",
  ["CREATE TABLE t(id INTEGER)", "ALTER TABLE t ADD COLUMN n INTEGER DEFAULT 7", "INSERT INTO t VALUES (1,9)"],
  "SELECT * FROM t",
);
parity(
  "added nullable column remains writable",
  ["CREATE TABLE t(id INTEGER)", "ALTER TABLE t ADD COLUMN note TEXT", "INSERT INTO t VALUES (1,'ok')"],
  "SELECT id,note,typeof(note) kind FROM t",
);
