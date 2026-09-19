import { errorParity, parity, sequenceParity } from "../helpers.ts";

parity(
  "expression unique index on lower(email)",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, email TEXT)",
    "CREATE UNIQUE INDEX t_email_lower ON t(lower(email))",
    "INSERT INTO t VALUES (1,'Ada@X')",
  ],
  "SELECT id,email FROM t WHERE lower(email)='ada@x'",
);

errorParity(
  "expression unique index rejects case-insensitive duplicates",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, email TEXT)",
    "CREATE UNIQUE INDEX t_email_lower ON t(lower(email))",
    "INSERT INTO t VALUES (1,'Ada@X')",
  ],
  "INSERT INTO t VALUES (2,'ada@x')",
  "constraint_unique",
);

parity(
  "json_extract expression index lookup",
  [
    "CREATE TABLE docs(id INTEGER PRIMARY KEY, data TEXT)",
    "CREATE INDEX docs_name ON docs(json_extract(data, '$.name'))",
    "INSERT INTO docs VALUES (1, json_object('name','ada','n',1))",
    "INSERT INTO docs VALUES (2, json_object('name','bob','n',2))",
  ],
  "SELECT id FROM docs WHERE json_extract(data, '$.name')='bob'",
);

sequenceParity(
  "expression unique index ON CONFLICT",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, email TEXT, note TEXT)",
    "CREATE UNIQUE INDEX t_email_lower ON t(lower(email))",
    "INSERT INTO t VALUES (1,'Ada@X','old')",
  ],
  [
    {
      sql: "INSERT INTO t(id,email,note) VALUES (2,'ada@x','new') ON CONFLICT(lower(email)) DO UPDATE SET note=excluded.note",
    },
    { sql: "SELECT id,email,note FROM t", query: true },
  ],
);

parity(
  "expression index with arithmetic",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, a INTEGER, b INTEGER)",
    "CREATE INDEX t_sum ON t(a+b)",
    "INSERT INTO t VALUES (1,2,3),(2,10,1)",
  ],
  "SELECT id FROM t WHERE a+b=11",
);
