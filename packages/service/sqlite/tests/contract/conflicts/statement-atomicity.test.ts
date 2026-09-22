import { sequenceParity } from "../helpers.ts";

const orModes = ["", "OR FAIL", "OR ABORT", "OR IGNORE", "OR REPLACE", "OR ROLLBACK"] as const;

for (const mode of orModes) {
  const clause = mode === "" ? "" : ` ${mode}`;
  const label = mode === "" ? "default" : mode;

  sequenceParity(
    `statement-atomicity INSERT ${label} UNIQUE mid-statement`,
    ["CREATE TABLE t(v INTEGER UNIQUE)", "INSERT INTO t VALUES (1)"],
    [
      { sql: "BEGIN" },
      { sql: `INSERT${clause} INTO t VALUES (2),(1),(3)` },
      { sql: "SELECT v FROM t ORDER BY v", query: true },
      { sql: "ROLLBACK" },
    ],
  );

  sequenceParity(
    `statement-atomicity INSERT ${label} CHECK mid-statement`,
    ["CREATE TABLE t(v INTEGER CHECK(v > 0))"],
    [
      { sql: "BEGIN" },
      { sql: `INSERT${clause} INTO t VALUES (1),(0),(3)` },
      { sql: "SELECT v FROM t ORDER BY v", query: true },
      { sql: "ROLLBACK" },
    ],
  );

  sequenceParity(
    `statement-atomicity INSERT ${label} NOT NULL mid-statement`,
    ["CREATE TABLE t(v INTEGER NOT NULL)"],
    [
      { sql: "BEGIN" },
      { sql: `INSERT${clause} INTO t VALUES (1),(NULL),(3)` },
      { sql: "SELECT v FROM t ORDER BY v", query: true },
      { sql: "ROLLBACK" },
    ],
  );
}

sequenceParity(
  "statement-atomicity INSERT OR ABORT FK mid-statement",
  [
    "PRAGMA foreign_keys=ON",
    "CREATE TABLE p(id INTEGER PRIMARY KEY)",
    "CREATE TABLE c(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES p(id))",
    "INSERT INTO p VALUES (1)",
  ],
  [
    { sql: "BEGIN" },
    { sql: "INSERT OR ABORT INTO c VALUES (10,1),(11,99),(12,1)" },
    { sql: "SELECT id, parent_id FROM c ORDER BY id", query: true },
    { sql: "ROLLBACK" },
  ],
);

sequenceParity(
  "statement-atomicity INSERT OR IGNORE UNIQUE mid-statement keeps valid rows",
  ["CREATE TABLE t(v INTEGER UNIQUE)", "INSERT INTO t VALUES (1)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT OR IGNORE INTO t VALUES (2),(1),(3)" },
    { sql: "SELECT v FROM t ORDER BY v", query: true },
    { sql: "COMMIT" },
  ],
);

sequenceParity(
  "statement-atomicity UPDATE OR FAIL UNIQUE mid-statement",
  ["CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER UNIQUE)", "INSERT INTO t VALUES (1,10),(2,20),(3,30)"],
  [
    { sql: "BEGIN" },
    { sql: "UPDATE OR FAIL t SET v = 10 WHERE id IN (2,3)" },
    { sql: "SELECT id, v FROM t ORDER BY id", query: true },
    { sql: "ROLLBACK" },
  ],
);

sequenceParity(
  "statement-atomicity UPDATE OR IGNORE UNIQUE mid-statement",
  ["CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER UNIQUE)", "INSERT INTO t VALUES (1,10),(2,20),(3,30)"],
  [
    { sql: "BEGIN" },
    { sql: "UPDATE OR IGNORE t SET v = 10 WHERE id IN (2,3)" },
    { sql: "SELECT id, v FROM t ORDER BY id", query: true },
    { sql: "COMMIT" },
  ],
);

sequenceParity(
  "statement-atomicity UPDATE OR FAIL CHECK mid-statement",
  ["CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER CHECK(v >= 0))", "INSERT INTO t VALUES (1,1),(2,2),(3,3)"],
  [
    { sql: "BEGIN" },
    { sql: "UPDATE OR FAIL t SET v = v - 5 WHERE id IN (1,2)" },
    { sql: "SELECT id, v FROM t ORDER BY id", query: true },
    { sql: "ROLLBACK" },
  ],
);

sequenceParity(
  "statement-atomicity autocommit INSERT OR ABORT UNIQUE",
  ["CREATE TABLE t(v INTEGER UNIQUE)", "INSERT INTO t VALUES (1)"],
  [{ sql: "INSERT OR ABORT INTO t VALUES (2),(1),(3)" }, { sql: "SELECT v FROM t ORDER BY v", query: true }],
);

sequenceParity(
  "statement-atomicity autocommit INSERT OR FAIL UNIQUE",
  ["CREATE TABLE t(v INTEGER UNIQUE)", "INSERT INTO t VALUES (1)"],
  [{ sql: "INSERT OR FAIL INTO t VALUES (2),(1),(3)" }, { sql: "SELECT v FROM t ORDER BY v", query: true }],
);
