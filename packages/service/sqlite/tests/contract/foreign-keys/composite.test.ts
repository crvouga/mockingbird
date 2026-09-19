import { errorParity, sequenceParity } from "../helpers.ts";

sequenceParity(
  "composite FK accepts matching parent pair",
  [
    "PRAGMA foreign_keys=ON",
    "CREATE TABLE parent(a INTEGER, b INTEGER, PRIMARY KEY(a,b))",
    "CREATE TABLE child(id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, FOREIGN KEY(a,b) REFERENCES parent(a,b))",
    "INSERT INTO parent VALUES (1,2)",
  ],
  [{ sql: "INSERT INTO child VALUES (10,1,2)" }, { sql: "SELECT id,a,b FROM child", query: true }],
);

errorParity(
  "composite FK rejects mismatched parent pair",
  [
    "PRAGMA foreign_keys=ON",
    "CREATE TABLE parent(a INTEGER, b INTEGER, PRIMARY KEY(a,b))",
    "CREATE TABLE child(id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, FOREIGN KEY(a,b) REFERENCES parent(a,b))",
    "INSERT INTO parent VALUES (1,2)",
  ],
  "INSERT INTO child VALUES (10,1,99)",
  "constraint_foreign",
);

errorParity(
  "composite FK rejects when only one column matches",
  [
    "PRAGMA foreign_keys=ON",
    "CREATE TABLE parent(a INTEGER, b INTEGER, PRIMARY KEY(a,b))",
    "CREATE TABLE child(id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, FOREIGN KEY(a,b) REFERENCES parent(a,b))",
    "INSERT INTO parent VALUES (1,2),(3,4)",
  ],
  "INSERT INTO child VALUES (10,1,4)",
  "constraint_foreign",
);

sequenceParity(
  "composite FK permits NULL in any child key column",
  [
    "PRAGMA foreign_keys=ON",
    "CREATE TABLE parent(a INTEGER, b INTEGER, PRIMARY KEY(a,b))",
    "CREATE TABLE child(id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, FOREIGN KEY(a,b) REFERENCES parent(a,b))",
    "INSERT INTO parent VALUES (1,2)",
  ],
  [
    { sql: "INSERT INTO child VALUES (10,1,NULL)" },
    { sql: "INSERT INTO child VALUES (11,NULL,2)" },
    { sql: "SELECT id,a,b FROM child ORDER BY id", query: true },
  ],
);

sequenceParity(
  "self-referential FK accepts NULL parent then later update",
  ["PRAGMA foreign_keys=ON", "CREATE TABLE tree(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES tree(id))"],
  [
    { sql: "INSERT INTO tree VALUES (1,NULL)" },
    { sql: "INSERT INTO tree VALUES (2,1)" },
    { sql: "SELECT id,parent_id FROM tree ORDER BY id", query: true },
  ],
);

errorParity(
  "self-referential FK rejects missing parent",
  ["PRAGMA foreign_keys=ON", "CREATE TABLE tree(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES tree(id))"],
  "INSERT INTO tree VALUES (2,99)",
  "constraint_foreign",
);

sequenceParity(
  "ON DELETE CASCADE with composite FK removes children",
  [
    "PRAGMA foreign_keys=ON",
    "CREATE TABLE parent(a INTEGER, b INTEGER, PRIMARY KEY(a,b))",
    "CREATE TABLE child(id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, FOREIGN KEY(a,b) REFERENCES parent(a,b) ON DELETE CASCADE)",
    "INSERT INTO parent VALUES (1,2),(3,4)",
    "INSERT INTO child VALUES (10,1,2),(11,3,4)",
  ],
  [{ sql: "DELETE FROM parent WHERE a=1 AND b=2" }, { sql: "SELECT id FROM child ORDER BY id", query: true }],
);

sequenceParity(
  "deferred composite FK commit succeeds after parent insert",
  [
    "PRAGMA foreign_keys=ON",
    "CREATE TABLE parent(a INTEGER, b INTEGER, PRIMARY KEY(a,b))",
    "CREATE TABLE child(id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, FOREIGN KEY(a,b) REFERENCES parent(a,b) DEFERRABLE INITIALLY DEFERRED)",
  ],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO child VALUES (10,5,6)" },
    { sql: "INSERT INTO parent VALUES (5,6)" },
    { sql: "COMMIT" },
    { sql: "SELECT id,a,b FROM child", query: true },
  ],
);
