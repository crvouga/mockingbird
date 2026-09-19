import { sequenceParity } from "../helpers.ts";

const modes = ["OR ABORT", "OR FAIL", "OR IGNORE", "OR REPLACE", "OR ROLLBACK"] as const;
const constraints = [
  {
    name: "UNIQUE",
    ddl: "CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER UNIQUE)",
    seed: "INSERT INTO t VALUES (1,10),(2,20)",
    insertConflict: "INSERT INTO t VALUES (3,10)",
    updateConflict: "UPDATE t SET v = 10 WHERE id = 2",
  },
  {
    name: "CHECK",
    ddl: "CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER CHECK(v BETWEEN 0 AND 100))",
    seed: "INSERT INTO t VALUES (1,10),(2,20)",
    insertConflict: "INSERT INTO t VALUES (3,999)",
    updateConflict: "UPDATE t SET v = -1 WHERE id = 2",
  },
  {
    name: "NOT NULL",
    ddl: "CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)",
    seed: "INSERT INTO t VALUES (1,10),(2,20)",
    insertConflict: "INSERT INTO t VALUES (3,NULL)",
    updateConflict: "UPDATE t SET v = NULL WHERE id = 2",
  },
] as const;

for (const mode of modes) {
  for (const c of constraints) {
    sequenceParity(
      `or-grid INSERT ${mode} vs ${c.name}`,
      [c.ddl, c.seed],
      [
        { sql: "BEGIN" },
        { sql: c.insertConflict.replace("INSERT INTO", `INSERT ${mode} INTO`) },
        { sql: "SELECT id, v FROM t ORDER BY id", query: true },
        { sql: "ROLLBACK" },
      ],
    );

    sequenceParity(
      `or-grid UPDATE ${mode} vs ${c.name}`,
      [c.ddl, c.seed],
      [
        { sql: "BEGIN" },
        { sql: c.updateConflict.replace("UPDATE t", `UPDATE ${mode} t`) },
        { sql: "SELECT id, v FROM t ORDER BY id", query: true },
        { sql: "ROLLBACK" },
      ],
    );
  }
}

sequenceParity(
  "or-grid INSERT OR REPLACE UNIQUE replaces conflicting row",
  ["CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER UNIQUE)", "INSERT INTO t VALUES (1,10),(2,20)"],
  [{ sql: "INSERT OR REPLACE INTO t VALUES (3,10)" }, { sql: "SELECT id, v FROM t ORDER BY id", query: true }],
);

sequenceParity(
  "or-grid INSERT OR IGNORE UNIQUE keeps existing",
  ["CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER UNIQUE)", "INSERT INTO t VALUES (1,10),(2,20)"],
  [{ sql: "INSERT OR IGNORE INTO t VALUES (3,10),(4,40)" }, { sql: "SELECT id, v FROM t ORDER BY id", query: true }],
);

sequenceParity(
  "or-grid PK OR REPLACE replaces by primary key",
  ["CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)", "INSERT INTO t VALUES (1,'a')"],
  [{ sql: "INSERT OR REPLACE INTO t VALUES (1,'b')" }, { sql: "SELECT id, v FROM t ORDER BY id", query: true }],
);

sequenceParity(
  "or-grid FK INSERT OR IGNORE still fails on missing parent",
  [
    "PRAGMA foreign_keys=ON",
    "CREATE TABLE p(id INTEGER PRIMARY KEY)",
    "CREATE TABLE c(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES p(id))",
    "INSERT INTO p VALUES (1)",
  ],
  [
    { sql: "BEGIN" },
    { sql: "INSERT OR IGNORE INTO c VALUES (10,99)" },
    { sql: "SELECT id, parent_id FROM c ORDER BY id", query: true },
    { sql: "ROLLBACK" },
  ],
);

sequenceParity(
  "or-grid FK INSERT OR ABORT rejects missing parent",
  [
    "PRAGMA foreign_keys=ON",
    "CREATE TABLE p(id INTEGER PRIMARY KEY)",
    "CREATE TABLE c(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES p(id))",
    "INSERT INTO p VALUES (1)",
  ],
  [
    { sql: "BEGIN" },
    { sql: "INSERT OR ABORT INTO c VALUES (10,99)" },
    { sql: "SELECT id, parent_id FROM c ORDER BY id", query: true },
    { sql: "ROLLBACK" },
  ],
);
