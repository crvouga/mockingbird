import { errorParity, sequenceParity } from "../helpers.ts";

errorParity(
  "insert violating FK",
  ["CREATE TABLE parent (id int PRIMARY KEY)", "CREATE TABLE child (pid int REFERENCES parent(id))"],
  "INSERT INTO child VALUES (1)",
  "constraint_foreign",
);

sequenceParity(
  "insert satisfying FK",
  [
    "CREATE TABLE parent (id int PRIMARY KEY)",
    "INSERT INTO parent VALUES (1), (2)",
    "CREATE TABLE child (id int, pid int REFERENCES parent(id))",
  ],
  [{ sql: "INSERT INTO child VALUES (10, 1), (11, 2)" }, { sql: "SELECT id, pid FROM child ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "null FK value is allowed",
  ["CREATE TABLE parent (id int PRIMARY KEY)", "CREATE TABLE child (id int, pid int REFERENCES parent(id))"],
  [{ sql: "INSERT INTO child VALUES (1, NULL)" }, { sql: "SELECT id, pid FROM child ORDER BY id", query: true }],
  { compareFinalState: true },
);

errorParity(
  "delete parent blocked by default NO ACTION",
  [
    "CREATE TABLE parent (id int PRIMARY KEY)",
    "INSERT INTO parent VALUES (1)",
    "CREATE TABLE child (pid int REFERENCES parent(id))",
    "INSERT INTO child VALUES (1)",
  ],
  "DELETE FROM parent WHERE id = 1",
  "constraint_foreign",
);

errorParity(
  "update parent key blocked by default NO ACTION",
  [
    "CREATE TABLE parent (id int PRIMARY KEY)",
    "INSERT INTO parent VALUES (1)",
    "CREATE TABLE child (pid int REFERENCES parent(id))",
    "INSERT INTO child VALUES (1)",
  ],
  "UPDATE parent SET id = 2 WHERE id = 1",
  "constraint_foreign",
);

errorParity(
  "update child to missing parent",
  [
    "CREATE TABLE parent (id int PRIMARY KEY)",
    "INSERT INTO parent VALUES (1)",
    "CREATE TABLE child (pid int REFERENCES parent(id))",
    "INSERT INTO child VALUES (1)",
  ],
  "UPDATE child SET pid = 99",
  "constraint_foreign",
);

sequenceParity(
  "delete parent after children removed",
  [
    "CREATE TABLE parent (id int PRIMARY KEY)",
    "INSERT INTO parent VALUES (1)",
    "CREATE TABLE child (pid int REFERENCES parent(id))",
    "INSERT INTO child VALUES (1)",
  ],
  [
    { sql: "DELETE FROM child" },
    { sql: "DELETE FROM parent WHERE id = 1" },
    { sql: "SELECT count(*) FROM parent", query: true },
  ],
  { compareFinalState: true },
);

errorParity(
  "named FK constraint violation",
  [
    "CREATE TABLE parent (id int PRIMARY KEY)",
    "CREATE TABLE child (pid int, CONSTRAINT child_parent_fk FOREIGN KEY (pid) REFERENCES parent(id))",
  ],
  "INSERT INTO child VALUES (5)",
  "constraint_foreign",
);

sequenceParity(
  "FK to explicitly unique non-PK column",
  [
    "CREATE TABLE parent (id int PRIMARY KEY, code text UNIQUE)",
    "INSERT INTO parent VALUES (1, 'A')",
    "CREATE TABLE child (code text REFERENCES parent(code))",
  ],
  [{ sql: "INSERT INTO child VALUES ('A')" }, { sql: "SELECT code FROM child", query: true }],
  { compareFinalState: true },
);
