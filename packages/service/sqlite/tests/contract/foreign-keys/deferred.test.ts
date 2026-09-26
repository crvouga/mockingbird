import { errorParity, execParity, parity, sequenceParity } from "../helpers.ts";

const deferredSchema = [
  "PRAGMA foreign_keys=ON",
  "CREATE TABLE parent(id INTEGER PRIMARY KEY)",
  "CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)",
];

sequenceParity("deferred FK allows orphan insert until commit", deferredSchema, [
  { sql: "BEGIN" },
  { sql: "INSERT INTO child VALUES (1, 99)" },
  { sql: "SELECT id, parent_id FROM child", query: true },
  { sql: "ROLLBACK" },
]);

errorParity(
  "deferred FK fails at COMMIT when parent is still missing",
  [...deferredSchema, "BEGIN", "INSERT INTO child VALUES (1, 99)"],
  "COMMIT",
  "constraint_foreign",
);

sequenceParity("deferred FK commit succeeds after parent is inserted", deferredSchema, [
  { sql: "BEGIN" },
  { sql: "INSERT INTO child VALUES (1, 7)" },
  { sql: "INSERT INTO parent VALUES (7)" },
  { sql: "COMMIT" },
  {
    sql: "SELECT child.id, child.parent_id, parent.id FROM child JOIN parent ON parent.id = child.parent_id",
    query: true,
  },
]);

errorParity(
  "immediate FK rejects orphan at the statement",
  [
    "PRAGMA foreign_keys=ON",
    "CREATE TABLE parent(id INTEGER PRIMARY KEY)",
    "CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY IMMEDIATE)",
  ],
  "INSERT INTO child VALUES (1, 99)",
  "constraint_foreign",
);

errorParity(
  "not deferrable FK rejects orphan at the statement",
  [
    "PRAGMA foreign_keys=ON",
    "CREATE TABLE parent(id INTEGER PRIMARY KEY)",
    "CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) NOT DEFERRABLE)",
  ],
  "INSERT INTO child VALUES (1, 99)",
  "constraint_foreign",
);

sequenceParity("rollback restores deferred FK state", deferredSchema, [
  { sql: "BEGIN" },
  { sql: "INSERT INTO child VALUES (1, 99)" },
  { sql: "ROLLBACK" },
  { sql: "SELECT count(*) AS n FROM child", query: true },
]);

execParity(
  "PRAGMA foreign_keys=OFF disables deferred FK checks",
  [
    "PRAGMA foreign_keys=OFF",
    "CREATE TABLE parent(id INTEGER PRIMARY KEY)",
    "CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)",
  ],
  "INSERT INTO child VALUES (1, 99)",
);

parity(
  "PRAGMA foreign_keys=OFF commit does not check deferred FKs",
  [
    "PRAGMA foreign_keys=OFF",
    "CREATE TABLE parent(id INTEGER PRIMARY KEY)",
    "CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)",
    "BEGIN",
    "INSERT INTO child VALUES (1, 99)",
    "COMMIT",
  ],
  "SELECT id, parent_id FROM child",
);

sequenceParity(
  "deferred FK on table-level constraint",
  [
    "PRAGMA foreign_keys=ON",
    "CREATE TABLE parent(id INTEGER PRIMARY KEY)",
    "CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER, FOREIGN KEY(parent_id) REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)",
  ],
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO child VALUES (1, 4)" },
    { sql: "INSERT INTO parent VALUES (4)" },
    { sql: "COMMIT" },
    { sql: "SELECT id FROM child", query: true },
  ],
);
