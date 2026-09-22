import { parity } from "../helpers.ts";

/** Partial index / hash lookup must not skip residual WHERE conjuncts on the simple-select path. */
parity(
  "partial index prefix does not skip second equality",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b INT)",
    "CREATE INDEX idx_a ON t(a)",
    "INSERT INTO t VALUES (1, 10, 100), (2, 10, 200), (3, 20, 300)",
  ],
  "SELECT id, a, b FROM t WHERE a = 10 AND b = 200 ORDER BY id",
);

parity(
  "equality hash on one column does not skip second equality",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b INT)",
    "INSERT INTO t VALUES (1,1,1), (2,1,2), (3,2,1), (4,2,2), (5,1,1)",
    "CREATE INDEX idx_a ON t(a)",
  ],
  "SELECT id, a, b FROM t WHERE a = 1 AND b = 1 ORDER BY id",
);
