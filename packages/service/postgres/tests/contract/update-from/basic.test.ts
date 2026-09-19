import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "UPDATE FROM basic join",
  [
    "CREATE TABLE accounts (id int, balance int)",
    "INSERT INTO accounts VALUES (1, 100), (2, 200)",
    "CREATE TABLE adjustments (account_id int, delta int)",
    "INSERT INTO adjustments VALUES (1, 50)",
  ],
  [
    {
      sql: "UPDATE accounts SET balance = balance + adjustments.delta FROM adjustments WHERE accounts.id = adjustments.account_id",
    },
    { sql: "SELECT id, balance FROM accounts ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "UPDATE FROM with source alias",
  [
    "CREATE TABLE t (id int, v text)",
    "INSERT INTO t VALUES (1, 'old'), (2, 'old')",
    "CREATE TABLE s (id int, v text)",
    "INSERT INTO s VALUES (1, 'new')",
  ],
  [
    { sql: "UPDATE t SET v = src.v FROM s AS src WHERE t.id = src.id" },
    { sql: "SELECT id, v FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "UPDATE FROM leaves non-matching rows intact",
  [
    "CREATE TABLE t (id int, n int)",
    "INSERT INTO t VALUES (1, 0), (2, 0), (3, 0)",
    "CREATE TABLE s (id int, n int)",
    "INSERT INTO s VALUES (2, 22)",
  ],
  [{ sql: "UPDATE t SET n = s.n FROM s WHERE t.id = s.id" }, { sql: "SELECT id, n FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "UPDATE FROM with extra WHERE predicate",
  [
    "CREATE TABLE t (id int, v text, active boolean)",
    "INSERT INTO t VALUES (1, 'a', true), (2, 'b', false)",
    "CREATE TABLE s (id int, v text)",
    "INSERT INTO s VALUES (1, 'A'), (2, 'B')",
  ],
  [
    { sql: "UPDATE t SET v = s.v FROM s WHERE t.id = s.id AND t.active" },
    { sql: "SELECT id, v, active FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "UPDATE FROM self join via alias",
  ["CREATE TABLE t (id int, n int)", "INSERT INTO t VALUES (1, 10), (2, 20)"],
  [
    { sql: "UPDATE t SET n = other.n FROM t AS other WHERE t.id = 1 AND other.id = 2" },
    { sql: "SELECT id, n FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "UPDATE FROM two source tables",
  [
    "CREATE TABLE t (id int, total int)",
    "INSERT INTO t VALUES (1, 0)",
    "CREATE TABLE a (id int, n int)",
    "INSERT INTO a VALUES (1, 5)",
    "CREATE TABLE b (id int, n int)",
    "INSERT INTO b VALUES (1, 7)",
  ],
  [
    { sql: "UPDATE t SET total = a.n + b.n FROM a, b WHERE t.id = a.id AND t.id = b.id" },
    { sql: "SELECT id, total FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "UPDATE FROM subquery source",
  [
    "CREATE TABLE t (id int, cnt int)",
    "INSERT INTO t VALUES (1, 0), (2, 0)",
    "CREATE TABLE events (tid int)",
    "INSERT INTO events VALUES (1), (1), (2)",
  ],
  [
    {
      sql: "UPDATE t SET cnt = agg.c FROM (SELECT tid, count(*) AS c FROM events GROUP BY tid) AS agg WHERE t.id = agg.tid",
    },
    { sql: "SELECT id, cnt FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "UPDATE FROM no matches updates nothing",
  [
    "CREATE TABLE t (id int, v text)",
    "INSERT INTO t VALUES (1, 'keep')",
    "CREATE TABLE s (id int, v text)",
    "INSERT INTO s VALUES (99, 'nope')",
  ],
  [{ sql: "UPDATE t SET v = s.v FROM s WHERE t.id = s.id" }, { sql: "SELECT id, v FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);
