import { errorParity, parity } from "../helpers.ts";

errorParity(
  "UPSERT target conflict still enforces other UNIQUE columns",
  ["CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT UNIQUE)", "INSERT INTO t(id, name) VALUES (2, ''),(6, 'keep')"],
  "INSERT INTO t(id, name) VALUES (6, '') ON CONFLICT(id) DO UPDATE SET name = excluded.name",
  "constraint_unique",
);

parity(
  "UPSERT on id updates when secondary UNIQUE is free",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT UNIQUE)",
    "INSERT INTO t(id, name) VALUES (2, 'a'),(6, 'keep')",
    "INSERT INTO t(id, name) VALUES (6, 'b') ON CONFLICT(id) DO UPDATE SET name = excluded.name",
  ],
  "SELECT id, name FROM t ORDER BY id",
);
