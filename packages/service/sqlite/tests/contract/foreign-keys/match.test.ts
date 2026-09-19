import { errorParity, parity, sequenceParity } from "../helpers.ts";

const base = [
  "PRAGMA foreign_keys=ON",
  "CREATE TABLE parent(a INTEGER, b INTEGER, PRIMARY KEY(a,b))",
  "INSERT INTO parent VALUES (1,1),(2,2)",
];

// SQLite parses MATCH FULL/PARTIAL but enforces MATCH SIMPLE only (any NULL skips the check).
parity(
  "MATCH SIMPLE accepts partial NULL child key",
  [
    ...base,
    "CREATE TABLE child_simple(id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, FOREIGN KEY(a,b) REFERENCES parent(a,b) MATCH SIMPLE)",
    "INSERT INTO child_simple VALUES (10,1,1)",
    "INSERT INTO child_simple VALUES (11,NULL,1)",
    "INSERT INTO child_simple VALUES (12,1,NULL)",
    "INSERT INTO child_simple VALUES (13,NULL,NULL)",
  ],
  "SELECT id, a, b FROM child_simple ORDER BY id",
);

errorParity(
  "MATCH SIMPLE rejects non-NULL missing parent",
  [
    ...base,
    "CREATE TABLE child_simple(id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, FOREIGN KEY(a,b) REFERENCES parent(a,b) MATCH SIMPLE)",
  ],
  "INSERT INTO child_simple VALUES (10,9,9)",
  "constraint_foreign",
);

parity(
  "MATCH FULL accepts partial NULL like SIMPLE (SQLite does not enforce FULL)",
  [
    ...base,
    "CREATE TABLE child_full(id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, FOREIGN KEY(a,b) REFERENCES parent(a,b) MATCH FULL)",
    "INSERT INTO child_full VALUES (10,1,NULL)",
    "INSERT INTO child_full VALUES (11,NULL,1)",
    "INSERT INTO child_full VALUES (12,NULL,NULL)",
  ],
  "SELECT id, a, b FROM child_full ORDER BY id",
);

parity(
  "MATCH FULL accepts complete matching child key",
  [
    ...base,
    "CREATE TABLE child_full(id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, FOREIGN KEY(a,b) REFERENCES parent(a,b) MATCH FULL)",
    "INSERT INTO child_full VALUES (10,1,1)",
  ],
  "SELECT id, a, b FROM child_full ORDER BY id",
);

errorParity(
  "MATCH FULL rejects complete missing parent",
  [
    ...base,
    "CREATE TABLE child_full(id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, FOREIGN KEY(a,b) REFERENCES parent(a,b) MATCH FULL)",
  ],
  "INSERT INTO child_full VALUES (10,9,9)",
  "constraint_foreign",
);

sequenceParity(
  "MATCH FULL UPDATE to partial NULL is accepted like SIMPLE",
  [
    ...base,
    "CREATE TABLE child_full(id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, FOREIGN KEY(a,b) REFERENCES parent(a,b) MATCH FULL)",
    "INSERT INTO child_full VALUES (10,1,1)",
  ],
  [
    { sql: "UPDATE child_full SET b = NULL WHERE id = 10" },
    { sql: "SELECT id, a, b FROM child_full ORDER BY id", query: true },
  ],
);

sequenceParity(
  "MATCH SIMPLE UPDATE to partial NULL is accepted",
  [
    ...base,
    "CREATE TABLE child_simple(id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, FOREIGN KEY(a,b) REFERENCES parent(a,b) MATCH SIMPLE)",
    "INSERT INTO child_simple VALUES (10,1,1)",
  ],
  [
    { sql: "UPDATE child_simple SET b = NULL WHERE id = 10" },
    { sql: "SELECT id, a, b FROM child_simple ORDER BY id", query: true },
  ],
);

sequenceParity(
  "MATCH FULL ON DELETE SET NULL clears all FK columns",
  [
    "PRAGMA foreign_keys=ON",
    "CREATE TABLE parent(a INTEGER, b INTEGER, PRIMARY KEY(a,b))",
    "CREATE TABLE child(id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, FOREIGN KEY(a,b) REFERENCES parent(a,b) ON DELETE SET NULL MATCH FULL)",
    "INSERT INTO parent VALUES (1,1)",
    "INSERT INTO child VALUES (10,1,1)",
  ],
  [{ sql: "DELETE FROM parent WHERE a=1 AND b=1" }, { sql: "SELECT id, a, b FROM child ORDER BY id", query: true }],
);

sequenceParity(
  "MATCH SIMPLE ON DELETE CASCADE removes matching child only",
  [
    "PRAGMA foreign_keys=ON",
    "CREATE TABLE parent(a INTEGER, b INTEGER, PRIMARY KEY(a,b))",
    "CREATE TABLE child(id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, FOREIGN KEY(a,b) REFERENCES parent(a,b) ON DELETE CASCADE MATCH SIMPLE)",
    "INSERT INTO parent VALUES (1,1)",
    "INSERT INTO child VALUES (10,1,1),(11,NULL,1)",
  ],
  [{ sql: "DELETE FROM parent WHERE a=1 AND b=1" }, { sql: "SELECT id, a, b FROM child ORDER BY id", query: true }],
);
