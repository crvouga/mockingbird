import { errorParity, sequenceParity } from "../helpers.ts";

errorParity(
  "UNIQUE rejects duplicate",
  ["CREATE TABLE t (email text UNIQUE)", "INSERT INTO t VALUES ('a@x.com')"],
  "INSERT INTO t VALUES ('a@x.com')",
  "constraint_unique",
);

sequenceParity(
  "UNIQUE allows multiple NULLs by default",
  ["CREATE TABLE t (v text UNIQUE)"],
  [{ sql: "INSERT INTO t VALUES (NULL), (NULL), (NULL)" }, { sql: "SELECT count(*) FROM t", query: true }],
  { compareFinalState: true },
);

errorParity(
  "UNIQUE NULLS NOT DISTINCT rejects second NULL",
  ["CREATE TABLE t (v text UNIQUE NULLS NOT DISTINCT)", "INSERT INTO t VALUES (NULL)"],
  "INSERT INTO t VALUES (NULL)",
  "constraint_unique",
);

errorParity(
  "composite UNIQUE rejects duplicate pair",
  ["CREATE TABLE t (a int, b int, UNIQUE (a, b))", "INSERT INTO t VALUES (1, 2)"],
  "INSERT INTO t VALUES (1, 2)",
  "constraint_unique",
);

sequenceParity(
  "composite UNIQUE allows differing pairs",
  ["CREATE TABLE t (a int, b int, UNIQUE (a, b))"],
  [{ sql: "INSERT INTO t VALUES (1, 2), (1, 3), (2, 2)" }, { sql: "SELECT a, b FROM t ORDER BY a, b", query: true }],
  { compareFinalState: true },
);

errorParity(
  "PRIMARY KEY rejects duplicate",
  ["CREATE TABLE t (id int PRIMARY KEY)", "INSERT INTO t VALUES (1)"],
  "INSERT INTO t VALUES (1)",
  "constraint_unique",
);

errorParity(
  "PRIMARY KEY implies NOT NULL",
  ["CREATE TABLE t (id int PRIMARY KEY)"],
  "INSERT INTO t VALUES (NULL)",
  "constraint_notnull",
);

errorParity(
  "composite PRIMARY KEY rejects duplicate pair",
  ["CREATE TABLE t (a int, b int, PRIMARY KEY (a, b))", "INSERT INTO t VALUES (1, 1)"],
  "INSERT INTO t VALUES (1, 1)",
  "constraint_unique",
);

sequenceParity(
  "composite PRIMARY KEY allows shared prefixes",
  ["CREATE TABLE t (a int, b int, PRIMARY KEY (a, b))"],
  [{ sql: "INSERT INTO t VALUES (1, 1), (1, 2), (2, 1)" }, { sql: "SELECT a, b FROM t ORDER BY a, b", query: true }],
  { compareFinalState: true },
);

errorParity(
  "composite PK component cannot be null",
  ["CREATE TABLE t (a int, b int, PRIMARY KEY (a, b))"],
  "INSERT INTO t VALUES (1, NULL)",
  "constraint_notnull",
);

errorParity(
  "named UNIQUE constraint",
  ["CREATE TABLE t (v int, CONSTRAINT v_uniq UNIQUE (v))", "INSERT INTO t VALUES (9)"],
  "INSERT INTO t VALUES (9)",
  "constraint_unique",
);

sequenceParity(
  "delete frees unique slot for reinsert",
  ["CREATE TABLE t (id int PRIMARY KEY)", "INSERT INTO t VALUES (1)"],
  [
    { sql: "DELETE FROM t WHERE id = 1" },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "SELECT id FROM t", query: true },
  ],
  { compareFinalState: true },
);
