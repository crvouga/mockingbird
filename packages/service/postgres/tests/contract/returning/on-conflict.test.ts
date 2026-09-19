import { parity, queryErrorParity, sequenceParity } from "../helpers.ts";

parity(
  "ON CONFLICT DO NOTHING RETURNING skips conflicting rows",
  ["CREATE TABLE t (id int PRIMARY KEY, v text)", "INSERT INTO t VALUES (1, 'existing')"],
  "INSERT INTO t VALUES (1, 'dup'), (2, 'new') ON CONFLICT DO NOTHING RETURNING id, v",
);

parity(
  "ON CONFLICT DO UPDATE RETURNING returns updated row",
  ["CREATE TABLE t (id int PRIMARY KEY, v text)", "INSERT INTO t VALUES (1, 'old')"],
  "INSERT INTO t VALUES (1, 'new') ON CONFLICT (id) DO UPDATE SET v = EXCLUDED.v RETURNING id, v",
);

parity(
  "ON CONFLICT DO UPDATE RETURNING mixes inserted and updated",
  ["CREATE TABLE t (id int PRIMARY KEY, n int)", "INSERT INTO t VALUES (1, 10)"],
  "INSERT INTO t VALUES (1, 100), (2, 200) ON CONFLICT (id) DO UPDATE SET n = EXCLUDED.n RETURNING id, n",
);

parity(
  "ON CONFLICT RETURNING expression",
  ["CREATE TABLE t (id int PRIMARY KEY, n int)", "INSERT INTO t VALUES (1, 5)"],
  "INSERT INTO t VALUES (1, 7) ON CONFLICT (id) DO UPDATE SET n = t.n + EXCLUDED.n RETURNING id, n * 2 AS twice",
);

parity(
  "all rows conflict DO NOTHING RETURNING is empty",
  ["CREATE TABLE t (id int PRIMARY KEY)", "INSERT INTO t VALUES (1), (2)"],
  "INSERT INTO t VALUES (1), (2) ON CONFLICT DO NOTHING RETURNING id",
);

sequenceParity(
  "RETURNING with ON CONFLICT then final state",
  ["CREATE TABLE t (id int PRIMARY KEY, v text)"],
  [
    { sql: "INSERT INTO t VALUES (1, 'a') RETURNING id", query: true },
    { sql: "INSERT INTO t VALUES (1, 'b') ON CONFLICT (id) DO UPDATE SET v = EXCLUDED.v RETURNING id, v", query: true },
    { sql: "INSERT INTO t VALUES (1, 'c') ON CONFLICT DO NOTHING RETURNING id, v", query: true },
    { sql: "SELECT id, v FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

queryErrorParity(
  "RETURNING undefined column errors",
  ["CREATE TABLE t (id int)"],
  "INSERT INTO t VALUES (1) RETURNING missing",
  "undefined_column",
);
