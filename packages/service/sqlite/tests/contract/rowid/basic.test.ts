import { parity, sequenceParity } from "../helpers.ts";

parity(
  "ordinary tables receive ascending implicit rowids",
  ["CREATE TABLE t(value TEXT)", "INSERT INTO t(value) VALUES ('a'),('b'),('c')"],
  "SELECT rowid,_rowid_,oid,value FROM t ORDER BY rowid",
);
parity(
  "INTEGER PRIMARY KEY aliases rowid",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY,value TEXT)",
    "INSERT INTO t(value) VALUES ('a'),('b')",
    "INSERT INTO t(id,value) VALUES (10,'ten')",
  ],
  "SELECT rowid,id,value FROM t ORDER BY id",
);
sequenceParity(
  "last_insert_rowid tracks generated key",
  ["CREATE TABLE t(id INTEGER PRIMARY KEY,value TEXT)"],
  [
    { sql: "INSERT INTO t(value) VALUES ('a')" },
    { sql: "SELECT last_insert_rowid() AS id", query: true },
    { sql: "INSERT INTO t(value) VALUES ('b')" },
    { sql: "SELECT last_insert_rowid() AS id", query: true },
  ],
);
parity(
  "explicit rowid is visible",
  ["CREATE TABLE t(value TEXT)", "INSERT INTO t(rowid,value) VALUES (42,'answer')"],
  "SELECT rowid,value FROM t",
);
