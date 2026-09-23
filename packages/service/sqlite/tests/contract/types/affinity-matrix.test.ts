import { parity, sequenceParity } from "../helpers.ts";

const affinities = ["INTEGER", "REAL", "TEXT", "BLOB", "NUMERIC", ""] as const;
const literals = ["42", "'42'", "42.0", "'42.0'", "'3.25'", "'abc'", "NULL", "X'4142'"] as const;

for (const affinity of affinities) {
  const decl = affinity === "" ? "v" : `v ${affinity}`;
  const label = affinity === "" ? "none" : affinity;
  for (const lit of literals) {
    parity(
      `affinity-matrix INSERT ${lit} into ${label}`,
      [`CREATE TABLE t(${decl})`, `INSERT INTO t VALUES (${lit})`],
      "SELECT v, typeof(v) AS t FROM t",
    );
  }
}

for (const affinity of ["INTEGER", "REAL", "TEXT", "BLOB", "NUMERIC"] as const) {
  parity(
    `affinity-matrix CAST numeric text AS ${affinity}`,
    [],
    `SELECT CAST('42' AS ${affinity}) AS v, typeof(CAST('42' AS ${affinity})) AS t`,
  );
  parity(
    `affinity-matrix CAST real text AS ${affinity}`,
    [],
    `SELECT CAST('3.25' AS ${affinity}) AS v, typeof(CAST('3.25' AS ${affinity})) AS t`,
  );
}

parity(
  "affinity-matrix UNION ALL mixes INTEGER and TEXT affinities",
  ["CREATE TABLE a(v INTEGER)", "CREATE TABLE b(v TEXT)", "INSERT INTO a VALUES (1)", "INSERT INTO b VALUES ('2')"],
  "SELECT v, typeof(v) AS t FROM (SELECT v FROM a UNION ALL SELECT v FROM b) AS u ORDER BY v",
);

parity(
  "affinity-matrix UNION coerces to common affinity",
  ["CREATE TABLE a(v INTEGER)", "CREATE TABLE b(v TEXT)", "INSERT INTO a VALUES (1)", "INSERT INTO b VALUES ('1')"],
  "SELECT v, typeof(v) AS t FROM (SELECT v FROM a UNION SELECT v FROM b) AS u ORDER BY v",
);

sequenceParity(
  "affinity-matrix INSERT SELECT applies destination affinity",
  ["CREATE TABLE src(v TEXT)", "CREATE TABLE dst(v INTEGER)", "INSERT INTO src VALUES ('7'),('8.0'),('x')"],
  [
    { sql: "INSERT INTO dst SELECT v FROM src" },
    { sql: "SELECT v, typeof(v) AS t FROM dst ORDER BY rowid", query: true },
  ],
);

sequenceParity(
  "affinity-matrix INSERT SELECT into REAL from mixed",
  ["CREATE TABLE src(v)", "CREATE TABLE dst(v REAL)", "INSERT INTO src VALUES (1),('2.5'),(X'31')"],
  [
    { sql: "INSERT INTO dst SELECT v FROM src" },
    { sql: "SELECT v, typeof(v) AS t FROM dst ORDER BY rowid", query: true },
  ],
);

sequenceParity(
  "affinity-matrix INSERT SELECT into NUMERIC from text numbers",
  ["CREATE TABLE src(v TEXT)", "CREATE TABLE dst(v NUMERIC)", "INSERT INTO src VALUES ('3'),('3.0'),('3.25'),('nope')"],
  [
    { sql: "INSERT INTO dst SELECT v FROM src" },
    { sql: "SELECT v, typeof(v) AS t FROM dst ORDER BY rowid", query: true },
  ],
);

sequenceParity(
  "affinity-matrix INSERT SELECT into BLOB preserves classes",
  ["CREATE TABLE src(v)", "CREATE TABLE dst(v BLOB)", "INSERT INTO src VALUES (1),(2.5),('hi'),(X'CAFE')"],
  [
    { sql: "INSERT INTO dst SELECT v FROM src" },
    { sql: "SELECT typeof(v) AS t, hex(v) AS h FROM dst ORDER BY rowid", query: true },
  ],
);

parity(
  "affinity-matrix comparison across affinities",
  ["CREATE TABLE t(i INTEGER, r REAL, txt TEXT, n NUMERIC)", "INSERT INTO t VALUES (1, 1.0, '1', 1)"],
  "SELECT i=r AS eq_ir, i=txt AS eq_it, i=n AS eq_in, r=txt AS eq_rt, typeof(i) AS ti, typeof(r) AS tr, typeof(txt) AS tt, typeof(n) AS tn FROM t",
);
