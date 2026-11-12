import { errorParity, parity, sequenceParity } from "../helpers.ts";

// #692: PostgreSQL 18 VIRTUAL generated columns and `ON DELETE SET NULL / SET DEFAULT (cols)`.

const generated = [
  "CREATE TABLE g (a int, b int GENERATED ALWAYS AS (a * 2) VIRTUAL, c int GENERATED ALWAYS AS (a + 1), d int GENERATED ALWAYS AS (a * 3) STORED)",
];

sequenceParity(
  "virtual generated columns compute on insert and update (VIRTUAL is the default)",
  generated,
  [
    { sql: "INSERT INTO g (a) VALUES (1), (2) RETURNING *", query: true },
    { sql: "UPDATE g SET a = 10 WHERE a = 1 RETURNING *", query: true },
    { sql: "ALTER TABLE g ADD COLUMN e int GENERATED ALWAYS AS (a - 1) VIRTUAL" },
    { sql: "SELECT * FROM g ORDER BY a", query: true },
  ],
  { compareFinalState: true },
);
parity(
  "pg_attribute.attgenerated tells virtual from stored",
  generated,
  "SELECT attname, attgenerated FROM pg_attribute WHERE attrelid = 'g'::regclass AND attnum > 0 ORDER BY attnum",
);
errorParity("an index on a virtual column", generated, "CREATE INDEX ON g (b)", "unsupported");
errorParity("a unique index on a virtual column", generated, "CREATE UNIQUE INDEX ON g (b)", "unsupported");
errorParity(
  "a unique constraint on a virtual column",
  generated,
  "ALTER TABLE g ADD CONSTRAINT u UNIQUE (b)",
  "unsupported",
);
errorParity(
  "a primary key on a virtual column",
  [],
  "CREATE TABLE gp (a int, b int GENERATED ALWAYS AS (a * 2) VIRTUAL PRIMARY KEY)",
  "unsupported",
);
errorParity(
  "a virtual column cannot call a user-defined function",
  ["CREATE FUNCTION f(int) RETURNS int IMMUTABLE LANGUAGE sql AS 'SELECT $1'"],
  "CREATE TABLE g2 (a int, b int GENERATED ALWAYS AS (f(a)) VIRTUAL)",
  "unsupported",
);
errorParity("writing a virtual column", generated, "INSERT INTO g (a, b) VALUES (1, 2)");
errorParity(
  "NOT NULL on a virtual column",
  ["CREATE TABLE g3 (a int, b int GENERATED ALWAYS AS (a * 2) VIRTUAL NOT NULL)"],
  "INSERT INTO g3 VALUES (NULL)",
  "constraint_notnull",
);
errorParity(
  "CHECK on a virtual column",
  ["CREATE TABLE g4 (a int, b int GENERATED ALWAYS AS (a * 2) VIRTUAL CHECK (b < 10))"],
  "INSERT INTO g4 VALUES (100)",
  "constraint_check",
);

const parent = ["CREATE TABLE par (a int, b int, PRIMARY KEY (a, b))", "INSERT INTO par VALUES (1, 1), (2, 1)"];

sequenceParity(
  "ON DELETE SET NULL (col) only clears the listed columns",
  [
    ...parent,
    "CREATE TABLE ch (id int, a int, b int, c int DEFAULT 5, FOREIGN KEY (a, b) REFERENCES par ON DELETE SET NULL (b))",
    "INSERT INTO ch VALUES (1, 1, 1)",
  ],
  [{ sql: "DELETE FROM par WHERE a = 1" }, { sql: "SELECT * FROM ch", query: true }],
  { compareFinalState: true },
);
parity(
  "the SET NULL column list in the catalog",
  [...parent, "CREATE TABLE ch (id int, a int, b int, FOREIGN KEY (a, b) REFERENCES par ON DELETE SET NULL (b))"],
  "SELECT pg_get_constraintdef(oid) AS def, confdelsetcols FROM pg_constraint WHERE conrelid = 'ch'::regclass AND contype = 'f'",
);
sequenceParity(
  "ON DELETE SET DEFAULT (col) sets only the listed columns, then rechecks the key",
  [
    ...parent,
    "INSERT INTO par VALUES (3, 1)",
    "CREATE TABLE ch4 (id int, a int DEFAULT 3, b int DEFAULT 1, FOREIGN KEY (a, b) REFERENCES par ON DELETE SET DEFAULT (a))",
    "INSERT INTO ch4 VALUES (1, 2, 1)",
  ],
  [{ sql: "DELETE FROM par WHERE a = 2" }, { sql: "SELECT * FROM ch4", query: true }],
  { compareFinalState: true },
);
errorParity(
  "SET DEFAULT (col) leaving a dangling key",
  [
    ...parent,
    "CREATE TABLE ch5 (id int, a int, b int DEFAULT 1, FOREIGN KEY (a, b) REFERENCES par ON DELETE SET DEFAULT (b))",
    "INSERT INTO ch5 VALUES (1, 2, 1)",
  ],
  "DELETE FROM par WHERE a = 2",
  "constraint_foreign",
);
errorParity(
  "ON UPDATE cannot take a column list",
  parent,
  "CREATE TABLE ch2 (id int, a int, b int, FOREIGN KEY (a, b) REFERENCES par ON UPDATE SET NULL (b))",
  "unsupported",
);
errorParity(
  "the column list must be part of the foreign key",
  parent,
  "CREATE TABLE ch3 (id int, a int, b int, FOREIGN KEY (a, b) REFERENCES par ON DELETE SET NULL (id))",
);
