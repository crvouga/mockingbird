import { parity } from "../helpers.ts";

parity(
  "literal defaults fill omitted columns",
  ["CREATE TABLE t(id INTEGER,label TEXT DEFAULT 'new',qty INTEGER DEFAULT 3)", "INSERT INTO t(id) VALUES (1)"],
  "SELECT * FROM t",
);
parity(
  "explicit NULL does not invoke default",
  ["CREATE TABLE t(id INTEGER,label TEXT DEFAULT 'new')", "INSERT INTO t VALUES (1,NULL)"],
  "SELECT * FROM t",
);
parity(
  "DEFAULT VALUES creates one row",
  ["CREATE TABLE t(a INTEGER DEFAULT 5,b TEXT DEFAULT 'x')", "INSERT INTO t DEFAULT VALUES"],
  "SELECT * FROM t",
);
parity(
  "parenthesized default expression is evaluated per insert",
  ["CREATE TABLE t(a INTEGER DEFAULT (1+2),b TEXT DEFAULT (upper('ok')))", "INSERT INTO t DEFAULT VALUES"],
  "SELECT * FROM t",
);
