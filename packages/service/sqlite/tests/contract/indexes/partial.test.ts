import { errorParity, parity, sequenceParity } from "../helpers.ts";

parity(
  "partial unique index allows duplicates outside the predicate",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, email TEXT, active INTEGER)",
    "CREATE UNIQUE INDEX t_email_active ON t(email) WHERE active = 1",
    "INSERT INTO t VALUES (1,'a@x',0),(2,'a@x',0)",
  ],
  "SELECT id,email,active FROM t ORDER BY id",
);

errorParity(
  "partial unique index rejects duplicates inside the predicate",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, email TEXT, active INTEGER)",
    "CREATE UNIQUE INDEX t_email_active ON t(email) WHERE active = 1",
    "INSERT INTO t VALUES (1,'a@x',1)",
  ],
  "INSERT INTO t VALUES (2,'a@x',1)",
  "constraint_unique",
);

sequenceParity(
  "updating a row into a partial unique index can conflict",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, email TEXT, active INTEGER)",
    "CREATE UNIQUE INDEX t_email_active ON t(email) WHERE active = 1",
    "INSERT INTO t VALUES (1,'a@x',1),(2,'a@x',0)",
  ],
  [{ sql: "UPDATE t SET active=1 WHERE id=2" }],
);

errorParity(
  "updating a row into a partial unique index conflicts",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, email TEXT, active INTEGER)",
    "CREATE UNIQUE INDEX t_email_active ON t(email) WHERE active = 1",
    "INSERT INTO t VALUES (1,'a@x',1),(2,'a@x',0)",
  ],
  "UPDATE t SET active=1 WHERE id=2",
  "constraint_unique",
);

sequenceParity(
  "ON CONFLICT DO NOTHING on a partial unique index",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, email TEXT, active INTEGER)",
    "CREATE UNIQUE INDEX t_email_active ON t(email) WHERE active = 1",
    "INSERT INTO t VALUES (1,'a@x',1)",
  ],
  [
    { sql: "INSERT INTO t(id,email,active) VALUES (2,'a@x',1) ON CONFLICT DO NOTHING" },
    { sql: "SELECT id,email,active FROM t ORDER BY id", query: true },
  ],
);

sequenceParity(
  "ON CONFLICT(email) WHERE active=1 updates the matching row",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, email TEXT, active INTEGER, note TEXT)",
    "CREATE UNIQUE INDEX t_email_active ON t(email) WHERE active = 1",
    "INSERT INTO t VALUES (1,'a@x',1,'old')",
  ],
  [
    {
      sql: "INSERT INTO t(id,email,active,note) VALUES (2,'a@x',1,'new') ON CONFLICT(email) WHERE active=1 DO UPDATE SET note=excluded.note",
    },
    { sql: "SELECT id,email,active,note FROM t ORDER BY id", query: true },
  ],
);

parity(
  "partial index does not change SELECT results",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, email TEXT, active INTEGER)",
    "CREATE INDEX t_email_active ON t(email) WHERE active = 1",
    "INSERT INTO t VALUES (1,'a@x',1),(2,'b@x',0),(3,'c@x',1)",
  ],
  "SELECT id,email FROM t WHERE email='c@x' AND active=1",
);

parity(
  "partial index appears in sqlite_master with WHERE",
  [
    "CREATE TABLE t(id INTEGER, email TEXT, active INTEGER)",
    "CREATE INDEX t_email_active ON t(email) WHERE active = 1",
  ],
  "SELECT name FROM sqlite_master WHERE type='index' AND name='t_email_active'",
);
