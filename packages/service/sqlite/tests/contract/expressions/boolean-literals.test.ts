import { parity, sequenceParity } from "../helpers.ts";

parity("TRUE and FALSE are integer 1 and 0", [], "SELECT true AS t, false AS f, TRUE AS T2, FALSE AS F2");

parity("typeof(true/false) is integer", [], "SELECT typeof(true) AS t, typeof(false) AS f");

parity(
  "boolean literals in arithmetic and CASE",
  [],
  "SELECT true + false AS a, NOT TRUE AS n, TRUE AND FALSE AS aand, TRUE OR FALSE AS oor, CASE WHEN TRUE THEN 1 ELSE 0 END AS c",
);

parity(
  "INSERT and WHERE with boolean literals",
  [
    "CREATE TABLE users (id TEXT PRIMARY KEY, is_anon INTEGER NOT NULL, updated_at TEXT NOT NULL) STRICT",
    "INSERT INTO users (id, is_anon, updated_at) VALUES ('u1', true, 't')",
  ],
  "SELECT id, is_anon FROM users WHERE is_anon = true",
);

sequenceParity(
  "UPDATE SET false and IS TRUE / IS FALSE filters",
  [
    "CREATE TABLE users (id TEXT PRIMARY KEY, is_anon INTEGER NOT NULL, updated_at TEXT NOT NULL) STRICT",
    "INSERT INTO users (id, is_anon, updated_at) VALUES ('u1', true, 't')",
  ],
  [
    { sql: "UPDATE users SET is_anon = false WHERE id = 'u1'" },
    { sql: "SELECT id, is_anon FROM users WHERE is_anon IS FALSE", query: true },
    { sql: "SELECT id FROM users WHERE is_anon IS TRUE", query: true },
    { sql: "SELECT id FROM users WHERE is_anon IS NOT FALSE", query: true },
    { sql: "SELECT id FROM users WHERE true", query: true },
  ],
);

parity(
  "IS TRUE / IS FALSE NULL three-valued logic",
  ["CREATE TABLE t(x)", "INSERT INTO t VALUES (NULL), (0), (1), (2), (-1), (''), ('x')"],
  `SELECT x,
          x IS TRUE AS is_t,
          x IS FALSE AS is_f,
          x IS NOT TRUE AS isnt_t,
          x IS NOT FALSE AS isnt_f,
          x = true AS eq_t,
          x = false AS eq_f
   FROM t
   ORDER BY rowid`,
);

parity(
  'quoted identifier "true" is a column, distinct from literal true',
  ['CREATE TABLE q("true" INT)', 'INSERT INTO q("true") VALUES (5)'],
  'SELECT "true" AS quoted_col, true AS lit FROM q',
);

parity(
  "column named true shadows the TRUE literal",
  ["CREATE TABLE bad(true INT)", "INSERT INTO bad VALUES (42)"],
  "SELECT true FROM bad",
);

parity(
  "CHECK constraint with IS TRUE",
  ["CREATE TABLE c(x INT CHECK (x IS TRUE))", "INSERT INTO c VALUES (1)"],
  "SELECT x FROM c",
);

parity(
  "DEFAULT true stores integer 1",
  ["CREATE TABLE d(id INTEGER PRIMARY KEY, flag INTEGER DEFAULT true)", "INSERT INTO d(id) VALUES (1)"],
  "SELECT id, flag FROM d",
);
