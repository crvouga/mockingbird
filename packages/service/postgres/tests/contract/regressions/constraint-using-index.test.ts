import { errorParity, sequenceParity } from "../helpers.ts";

// #537 ALTER TABLE ... ADD CONSTRAINT ... { UNIQUE | PRIMARY KEY } USING INDEX
const base = [
  "CREATE SCHEMA ui",
  "CREATE TABLE ui.p (id uuid PRIMARY KEY, op_id uuid, k text, j int)",
  "CREATE UNIQUE INDEX p_op_idx ON ui.p (op_id)",
];
const constraints = (table: string) =>
  `SELECT c.conname, c.contype, c.conindid::regclass::text AS idx, c.condeferrable FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid WHERE r.relname = '${table}' AND c.contype IN ('u', 'p') ORDER BY 1`;
const indexes = (table: string) =>
  `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'ui' AND tablename = '${table}' ORDER BY 1`;

sequenceParity(
  "#537 UNIQUE USING INDEX promotes the index and renames it to the constraint",
  base,
  [
    { sql: "ALTER TABLE ui.p ADD CONSTRAINT uq_p_op UNIQUE USING INDEX p_op_idx" },
    { sql: constraints("p"), query: true },
    { sql: indexes("p"), query: true },
    {
      sql: "INSERT INTO ui.p (id, op_id) VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000aa')",
    },
    {
      sql: "INSERT INTO ui.p (id, op_id) VALUES ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000aa')",
    },
    {
      sql: "INSERT INTO ui.p (id, op_id) VALUES ('00000000-0000-0000-0000-000000000003', NULL), ('00000000-0000-0000-0000-000000000004', NULL)",
    },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "#537 PRIMARY KEY USING INDEX on a NOT NULL column",
  ["CREATE SCHEMA ui", "CREATE TABLE ui.q (id int NOT NULL)", "CREATE UNIQUE INDEX q_id_idx ON ui.q (id)"],
  [
    { sql: "ALTER TABLE ui.q ADD CONSTRAINT q_pk PRIMARY KEY USING INDEX q_id_idx" },
    { sql: constraints("q"), query: true },
    { sql: indexes("q"), query: true },
    { sql: "INSERT INTO ui.q VALUES (1)" },
    { sql: "INSERT INTO ui.q VALUES (1)" },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "#537 PRIMARY KEY USING INDEX makes the key columns NOT NULL",
  [
    "CREATE SCHEMA ui",
    "CREATE TABLE ui.n (b int)",
    "CREATE UNIQUE INDEX n_b ON ui.n (b)",
    "INSERT INTO ui.n VALUES (1)",
  ],
  [
    { sql: "ALTER TABLE ui.n ADD CONSTRAINT n_pk PRIMARY KEY USING INDEX n_b" },
    {
      sql: "SELECT attname, attnotnull FROM pg_attribute WHERE attrelid = 'ui.n'::regclass AND attnum > 0",
      query: true,
    },
    { sql: "INSERT INTO ui.n VALUES (NULL)" },
  ],
  { compareFinalState: true },
);

errorParity(
  "#537 PRIMARY KEY USING INDEX refuses a column that holds a null",
  [
    "CREATE SCHEMA ui",
    "CREATE TABLE ui.n (b int)",
    "CREATE UNIQUE INDEX n_b ON ui.n (b)",
    "INSERT INTO ui.n VALUES (NULL)",
  ],
  "ALTER TABLE ui.n ADD CONSTRAINT n_pk PRIMARY KEY USING INDEX n_b",
);

sequenceParity(
  "#537 the constraint name defaults to the index name",
  ["CREATE SCHEMA ui", "CREATE TABLE ui.e (a int, b int)", "CREATE UNIQUE INDEX e_a ON ui.e (a)"],
  [
    { sql: "ALTER TABLE ui.e ADD UNIQUE USING INDEX e_a" },
    { sql: constraints("e"), query: true },
    { sql: indexes("e"), query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "#537 DROP CONSTRAINT removes the constraint and its index",
  base,
  [
    { sql: "ALTER TABLE ui.p ADD CONSTRAINT uq_p_op UNIQUE USING INDEX p_op_idx" },
    { sql: "ALTER TABLE ui.p DROP CONSTRAINT uq_p_op" },
    { sql: constraints("p"), query: true },
    { sql: indexes("p"), query: true },
    {
      sql: "INSERT INTO ui.p (id, op_id) VALUES ('00000000-0000-0000-0000-000000000001', NULL), ('00000000-0000-0000-0000-000000000002', NULL)",
    },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "#537 a promoted index can back a foreign key, carries INCLUDE columns and accepts DEFERRABLE",
  [
    "CREATE SCHEMA ui",
    "CREATE TABLE ui.g (a int, b int)",
    "CREATE UNIQUE INDEX g_a ON ui.g (a)",
    "CREATE TABLE ui.f (a int, b int)",
    "CREATE UNIQUE INDEX f_a ON ui.f (a) INCLUDE (b)",
  ],
  [
    { sql: "ALTER TABLE ui.g ADD CONSTRAINT g_a_c UNIQUE USING INDEX g_a" },
    { sql: "CREATE TABLE ui.h (a int REFERENCES ui.g (a))" },
    { sql: "INSERT INTO ui.g VALUES (1, 1)" },
    { sql: "INSERT INTO ui.h VALUES (1)" },
    { sql: "INSERT INTO ui.h VALUES (2)" },
    { sql: "ALTER TABLE ui.f ADD CONSTRAINT f_a_c UNIQUE USING INDEX f_a" },
    { sql: "ALTER INDEX ui.f_a_c RENAME TO f_a_d" },
    { sql: constraints("f"), query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "#537 inside a rolled-back transaction the index is back",
  base,
  [
    { sql: "BEGIN" },
    { sql: "ALTER TABLE ui.p ADD CONSTRAINT uq_p_op UNIQUE USING INDEX p_op_idx" },
    { sql: "ROLLBACK" },
    { sql: constraints("p"), query: true },
    { sql: indexes("p"), query: true },
  ],
  { compareFinalState: true },
);

// the index is refused
errorParity(
  "#537 a non-unique index",
  [...base, "CREATE INDEX p_k_idx ON ui.p (k)"],
  "ALTER TABLE ui.p ADD CONSTRAINT uq_p_k UNIQUE USING INDEX p_k_idx",
);
errorParity(
  "#537 an index that does not exist",
  base,
  "ALTER TABLE ui.p ADD CONSTRAINT uq_p_nope UNIQUE USING INDEX no_such_idx",
);
const b7 = [
  "CREATE SCHEMA ui",
  "CREATE TABLE ui.b7 (a int NOT NULL, b int)",
  "CREATE UNIQUE INDEX b7_part ON ui.b7 (a) WHERE a > 0",
  "CREATE UNIQUE INDEX b7_expr ON ui.b7 ((a + 1))",
  "CREATE UNIQUE INDEX b7_desc ON ui.b7 (b DESC)",
  "CREATE UNIQUE INDEX c3 ON ui.b7 (a)",
  "ALTER TABLE ui.b7 ADD CONSTRAINT c3 UNIQUE USING INDEX c3",
  "CREATE TABLE ui.other (a int)",
  "CREATE UNIQUE INDEX other_a ON ui.other (a)",
];
errorParity("#537 a partial index", b7, "ALTER TABLE ui.b7 ADD CONSTRAINT x UNIQUE USING INDEX b7_part");
errorParity("#537 an expression index", b7, "ALTER TABLE ui.b7 ADD CONSTRAINT x UNIQUE USING INDEX b7_expr");
errorParity("#537 a descending index", b7, "ALTER TABLE ui.b7 ADD CONSTRAINT x UNIQUE USING INDEX b7_desc");
errorParity(
  "#537 an index already owned by a constraint",
  b7,
  "ALTER TABLE ui.b7 ADD CONSTRAINT x UNIQUE USING INDEX c3",
);
errorParity("#537 an index of another table", b7, "ALTER TABLE ui.b7 ADD CONSTRAINT x UNIQUE USING INDEX other_a");
errorParity(
  "#537 the constraint name is a relation already",
  [...b7, "CREATE UNIQUE INDEX b7_b ON ui.b7 (b)"],
  "ALTER TABLE ui.b7 ADD CONSTRAINT other_a UNIQUE USING INDEX b7_b",
);
errorParity(
  "#537 a second primary key",
  [...b7, "CREATE UNIQUE INDEX b7_b ON ui.b7 (b)", "ALTER TABLE ui.b7 ADD PRIMARY KEY (a)"],
  "ALTER TABLE ui.b7 ADD CONSTRAINT y PRIMARY KEY USING INDEX b7_b",
);
