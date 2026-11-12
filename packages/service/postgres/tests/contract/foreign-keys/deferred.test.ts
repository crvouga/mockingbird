import { errorParity, parity, sequenceParity } from "../helpers.ts";

// #683: DEFERRABLE foreign keys are checked at COMMIT (or SET CONSTRAINTS ... IMMEDIATE), not per statement.
const parent = "CREATE TABLE parent (id int PRIMARY KEY)";

sequenceParity(
  "INITIALLY DEFERRED foreign key accepts the child before its parent (#683)",
  [parent, "CREATE TABLE child (pid int REFERENCES parent (id) DEFERRABLE INITIALLY DEFERRED)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO child VALUES (1)" },
    { sql: "INSERT INTO parent VALUES (1)" },
    { sql: "COMMIT" },
    { sql: "SELECT count(*)::int AS children FROM child", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "SET CONSTRAINTS ALL DEFERRED defers an INITIALLY IMMEDIATE foreign key (#683)",
  [parent, "CREATE TABLE child (pid int REFERENCES parent (id) DEFERRABLE INITIALLY IMMEDIATE)"],
  [
    { sql: "BEGIN" },
    { sql: "SET CONSTRAINTS ALL DEFERRED" },
    { sql: "INSERT INTO child VALUES (2)" },
    { sql: "INSERT INTO parent VALUES (2)" },
    { sql: "COMMIT" },
    { sql: "SELECT count(*)::int AS children FROM child", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "a deferred foreign key still violated at COMMIT fails it and rolls back (#683)",
  [parent, "CREATE TABLE child (pid int REFERENCES parent DEFERRABLE INITIALLY DEFERRED)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO parent VALUES (5)" },
    { sql: "INSERT INTO child VALUES (6)" },
    { sql: "COMMIT" },
    { sql: "SELECT count(*)::int AS parents FROM parent", query: true },
  ],
);

sequenceParity(
  "deleting a referenced row is deferred under NO ACTION and can be repaired before COMMIT (#683)",
  [
    parent,
    "INSERT INTO parent VALUES (1), (2)",
    "CREATE TABLE child (pid int, FOREIGN KEY (pid) REFERENCES parent DEFERRABLE INITIALLY DEFERRED)",
    "INSERT INTO child VALUES (1), (2)",
  ],
  [
    { sql: "BEGIN" },
    { sql: "DELETE FROM parent" },
    { sql: "INSERT INTO parent VALUES (1)" },
    { sql: "UPDATE child SET pid = NULL WHERE pid = 2" },
    { sql: "COMMIT" },
    { sql: "SELECT pid FROM child ORDER BY pid", query: true },
    { sql: "BEGIN" },
    { sql: "DELETE FROM parent" },
    { sql: "COMMIT" },
    { sql: "SELECT id FROM parent", query: true },
  ],
);

sequenceParity(
  "SET CONSTRAINTS IMMEDIATE checks queued foreign keys, and a self-reference cycle commits (#683)",
  ["CREATE TABLE node (id int PRIMARY KEY, next int REFERENCES node INITIALLY DEFERRED)"],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO node VALUES (1, 2)" },
    { sql: "INSERT INTO node VALUES (2, 1)" },
    { sql: "SET CONSTRAINTS node_next_fkey IMMEDIATE" },
    { sql: "COMMIT" },
    { sql: "BEGIN" },
    { sql: "UPDATE node SET next = 3 WHERE id = 1" },
    { sql: "SET CONSTRAINTS ALL IMMEDIATE" },
    { sql: "ROLLBACK" },
    { sql: "SELECT * FROM node ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "rows inserted after ROLLBACK TO SAVEPOINT are what COMMIT checks (#683)",
  [parent, "CREATE TABLE child (pid int NOT NULL REFERENCES parent DEFERRABLE)"],
  [
    { sql: "BEGIN" },
    { sql: "SET CONSTRAINTS ALL DEFERRED" },
    { sql: "INSERT INTO child VALUES (42)" },
    { sql: "SAVEPOINT s" },
    { sql: "INSERT INTO child VALUES (43)" },
    { sql: "ROLLBACK TO s" },
    { sql: "INSERT INTO parent VALUES (42)" },
    { sql: "COMMIT" },
    { sql: "SELECT pid FROM child", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "SET CONSTRAINTS IMMEDIATE on a deferrable foreign key restores the per-statement check (#683)",
  [parent, "CREATE TABLE child (pid int REFERENCES parent DEFERRABLE INITIALLY DEFERRED)"],
  [{ sql: "BEGIN" }, { sql: "SET CONSTRAINTS child_pid_fkey IMMEDIATE" }, { sql: "INSERT INTO child VALUES (9)" }],
);

errorParity(
  "outside a transaction block a deferred foreign key is checked at once (#683)",
  [parent, "CREATE TABLE child (pid int REFERENCES parent INITIALLY DEFERRED)"],
  "INSERT INTO child VALUES (5)",
  "constraint_foreign",
);

errorParity(
  "ALTER TABLE ADD a deferrable foreign key validates existing rows immediately (#683)",
  [parent, "CREATE TABLE late (pid int)", "INSERT INTO late VALUES (55)"],
  "ALTER TABLE late ADD CONSTRAINT late_fk FOREIGN KEY (pid) REFERENCES parent DEFERRABLE INITIALLY DEFERRED",
  "constraint_foreign",
);

errorParity(
  "ON DELETE RESTRICT is never deferred and reports 23001 (#683)",
  [
    parent,
    "INSERT INTO parent VALUES (1)",
    "CREATE TABLE child (pid int REFERENCES parent ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED)",
    "INSERT INTO child VALUES (1)",
  ],
  "DELETE FROM parent",
);

errorParity(
  "NOT DEFERRABLE with INITIALLY DEFERRED is rejected (#683)",
  [parent],
  "CREATE TABLE child (pid int REFERENCES parent NOT DEFERRABLE INITIALLY DEFERRED)",
  "syntax",
);

errorParity(
  "a detached DEFERRABLE clause is misplaced (#683)",
  [parent],
  "CREATE TABLE child (pid int REFERENCES parent NOT NULL DEFERRABLE)",
  "syntax",
);

parity(
  "pg_constraint and information_schema report foreign key deferrability (#683)",
  [
    parent,
    "CREATE TABLE a (pid int REFERENCES parent INITIALLY DEFERRED)",
    "CREATE TABLE b (pid int REFERENCES parent DEFERRABLE)",
    "CREATE TABLE c (pid int REFERENCES parent)",
  ],
  `SELECT c.conname, c.condeferrable, c.condeferred, t.is_deferrable, t.initially_deferred
   FROM pg_constraint c JOIN information_schema.table_constraints t ON t.constraint_name = c.conname
   WHERE c.contype = 'f' ORDER BY c.conname`,
);
