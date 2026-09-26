import { parity, sequenceParity } from "../helpers.ts";

parity(
  "sqlite_master.sql stores CREATE TABLE text",
  ["CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE)"],
  "SELECT type, name, sql FROM sqlite_master WHERE name='users'",
);

parity(
  "sqlite_master.sql strips IF NOT EXISTS",
  ["CREATE TABLE IF NOT EXISTS t(x INT)"],
  "SELECT sql FROM sqlite_master WHERE name='t'",
);

parity(
  "sqlite_master.sql stores CREATE INDEX text",
  ["CREATE TABLE t(x INT)", "CREATE INDEX t_x ON t(x)"],
  "SELECT sql FROM sqlite_master WHERE name='t_x'",
);

parity(
  "sqlite_master.sql strips IF NOT EXISTS on UNIQUE INDEX",
  ["CREATE TABLE t(x INT)", "CREATE UNIQUE INDEX IF NOT EXISTS t_x ON t(x)"],
  "SELECT sql FROM sqlite_master WHERE name='t_x'",
);

parity(
  "sqlite_master.sql stores CREATE VIEW text",
  ["CREATE TABLE t(id INT)", "CREATE VIEW v AS SELECT id FROM t WHERE id > 0"],
  "SELECT sql FROM sqlite_master WHERE name='v'",
);

parity(
  "sqlite_master.sql stores CREATE TRIGGER text",
  ["CREATE TABLE t(id INTEGER PRIMARY KEY)", "CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END"],
  "SELECT sql FROM sqlite_master WHERE name='tr'",
);

parity(
  "sqlite_master.sql for CTAS is synthesized column list",
  ["CREATE TABLE ct AS SELECT 1 AS a, 2 AS b"],
  "SELECT sql FROM sqlite_master WHERE name='ct'",
);

sequenceParity(
  "TEMP table sql appears without TEMP keyword",
  [],
  [
    { sql: "CREATE TEMP TABLE tmp(x INT)" },
    { sql: "SELECT sql FROM temp.sqlite_master WHERE name='tmp'", query: true },
  ],
);
