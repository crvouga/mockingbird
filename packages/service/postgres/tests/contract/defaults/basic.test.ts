import { parity, sequenceParity } from "../helpers.ts";

parity(
  "literal int default",
  ["CREATE TABLE t (id int, n int DEFAULT 7)", "INSERT INTO t (id) VALUES (1)"],
  "SELECT id, n FROM t",
);

parity(
  "literal text default",
  ["CREATE TABLE t (id int, v text DEFAULT 'hello')", "INSERT INTO t (id) VALUES (1)"],
  "SELECT id, v FROM t",
);

parity(
  "boolean and numeric defaults",
  ["CREATE TABLE t (id int, flag boolean DEFAULT true, price numeric DEFAULT 9.99)", "INSERT INTO t (id) VALUES (1)"],
  "SELECT id, flag, price FROM t",
);

parity(
  "NULL default is explicit",
  ["CREATE TABLE t (id int, v text DEFAULT NULL)", "INSERT INTO t (id) VALUES (1)"],
  "SELECT id, v FROM t",
);

parity(
  "expression default arithmetic",
  ["CREATE TABLE t (id int, n int DEFAULT 2 + 3 * 4)", "INSERT INTO t (id) VALUES (1)"],
  "SELECT id, n FROM t",
);

parity(
  "expression default function call",
  ["CREATE TABLE t (id int, v text DEFAULT upper('abc') || '!')", "INSERT INTO t (id) VALUES (1)"],
  "SELECT id, v FROM t",
);

parity(
  "default with cast",
  ["CREATE TABLE t (id int, n numeric DEFAULT '42.5'::numeric)", "INSERT INTO t (id) VALUES (1)"],
  "SELECT id, n FROM t",
);

sequenceParity(
  "default only used when column omitted",
  ["CREATE TABLE t (id int, n int DEFAULT 100)"],
  [
    { sql: "INSERT INTO t VALUES (1, 1)" },
    { sql: "INSERT INTO t (id) VALUES (2)" },
    { sql: "INSERT INTO t VALUES (3, DEFAULT)" },
    { sql: "SELECT id, n FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "serial default advances per row",
  ["CREATE TABLE t (id serial, tag text)"],
  [
    { sql: "INSERT INTO t (tag) VALUES ('a')" },
    { sql: "INSERT INTO t (tag) VALUES ('b'), ('c')" },
    { sql: "SELECT id, tag FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

parity(
  "multiple defaults in one table",
  ["CREATE TABLE t (a int DEFAULT 1, b int DEFAULT 2, c int DEFAULT 3)", "INSERT INTO t (b) VALUES (20)"],
  "SELECT a, b, c FROM t",
);
