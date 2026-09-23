import { errorParity, sequenceParity } from "../helpers.ts";

sequenceParity(
  "ON DELETE CASCADE removes children",
  [
    "CREATE TABLE parent (id int PRIMARY KEY)",
    "INSERT INTO parent VALUES (1), (2)",
    "CREATE TABLE child (id int, pid int REFERENCES parent(id) ON DELETE CASCADE)",
    "INSERT INTO child VALUES (10, 1), (11, 1), (12, 2)",
  ],
  [{ sql: "DELETE FROM parent WHERE id = 1" }, { sql: "SELECT id, pid FROM child ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "ON DELETE SET NULL nulls child references",
  [
    "CREATE TABLE parent (id int PRIMARY KEY)",
    "INSERT INTO parent VALUES (1), (2)",
    "CREATE TABLE child (id int, pid int REFERENCES parent(id) ON DELETE SET NULL)",
    "INSERT INTO child VALUES (10, 1), (11, 2)",
  ],
  [{ sql: "DELETE FROM parent WHERE id = 1" }, { sql: "SELECT id, pid FROM child ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "ON DELETE SET DEFAULT uses column default",
  [
    "CREATE TABLE parent (id int PRIMARY KEY)",
    "INSERT INTO parent VALUES (0), (1)",
    "CREATE TABLE child (id int, pid int DEFAULT 0 REFERENCES parent(id) ON DELETE SET DEFAULT)",
    "INSERT INTO child VALUES (10, 1)",
  ],
  [{ sql: "DELETE FROM parent WHERE id = 1" }, { sql: "SELECT id, pid FROM child ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "ON UPDATE CASCADE propagates new key",
  [
    "CREATE TABLE parent (id int PRIMARY KEY)",
    "INSERT INTO parent VALUES (1)",
    "CREATE TABLE child (id int, pid int REFERENCES parent(id) ON UPDATE CASCADE)",
    "INSERT INTO child VALUES (10, 1)",
  ],
  [{ sql: "UPDATE parent SET id = 100 WHERE id = 1" }, { sql: "SELECT id, pid FROM child ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "ON UPDATE SET NULL nulls child references",
  [
    "CREATE TABLE parent (id int PRIMARY KEY)",
    "INSERT INTO parent VALUES (1)",
    "CREATE TABLE child (id int, pid int REFERENCES parent(id) ON UPDATE SET NULL)",
    "INSERT INTO child VALUES (10, 1)",
  ],
  [{ sql: "UPDATE parent SET id = 2 WHERE id = 1" }, { sql: "SELECT id, pid FROM child ORDER BY id", query: true }],
  { compareFinalState: true },
);

errorParity(
  "explicit NO ACTION blocks parent delete",
  [
    "CREATE TABLE parent (id int PRIMARY KEY)",
    "INSERT INTO parent VALUES (1)",
    "CREATE TABLE child (pid int REFERENCES parent(id) ON DELETE NO ACTION)",
    "INSERT INTO child VALUES (1)",
  ],
  "DELETE FROM parent WHERE id = 1",
  "constraint_foreign",
);

sequenceParity(
  "cascade chain across two levels",
  [
    "CREATE TABLE a (id int PRIMARY KEY)",
    "INSERT INTO a VALUES (1)",
    "CREATE TABLE b (id int PRIMARY KEY, aid int REFERENCES a(id) ON DELETE CASCADE)",
    "INSERT INTO b VALUES (10, 1)",
    "CREATE TABLE c (id int, bid int REFERENCES b(id) ON DELETE CASCADE)",
    "INSERT INTO c VALUES (100, 10)",
  ],
  [
    { sql: "DELETE FROM a WHERE id = 1" },
    { sql: "SELECT count(*) FROM b", query: true },
    { sql: "SELECT count(*) FROM c", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "cascade delete only affects matching children",
  [
    "CREATE TABLE parent (id int PRIMARY KEY)",
    "INSERT INTO parent VALUES (1), (2)",
    "CREATE TABLE child (id int, pid int REFERENCES parent(id) ON DELETE CASCADE)",
    "INSERT INTO child VALUES (10, 1), (20, 2)",
  ],
  [{ sql: "DELETE FROM parent WHERE id = 2" }, { sql: "SELECT id, pid FROM child ORDER BY id", query: true }],
  { compareFinalState: true },
);
