import { parity } from "../helpers.ts";

const events = [
  "CREATE TABLE events (id int, user_id int, kind text, at int)",
  "INSERT INTO events VALUES (1, 1, 'a', 10), (2, 1, 'b', 20), (3, 2, 'a', 5), (4, 2, 'c', 15), (5, 3, 'a', 1)",
];

parity(
  "distinct on single key latest per user",
  events,
  "SELECT DISTINCT ON (user_id) user_id, kind, at FROM events ORDER BY user_id, at DESC",
);
parity(
  "distinct on single key earliest per user",
  events,
  "SELECT DISTINCT ON (user_id) user_id, kind, at FROM events ORDER BY user_id, at ASC",
);
parity(
  "distinct on with extra sort keys",
  events,
  "SELECT DISTINCT ON (user_id) user_id, kind, at FROM events ORDER BY user_id, at DESC, kind ASC",
);
parity(
  "distinct on multiple keys",
  ["CREATE TABLE t (a int, b int, c int)", "INSERT INTO t VALUES (1, 1, 9), (1, 1, 3), (1, 2, 5), (2, 1, 7)"],
  "SELECT DISTINCT ON (a, b) a, b, c FROM t ORDER BY a, b, c",
);
parity(
  "distinct on expression key",
  ["CREATE TABLE t (n int)", "INSERT INTO t VALUES (1), (2), (3), (4), (5)"],
  "SELECT DISTINCT ON (n % 2) n % 2 AS parity, n FROM t ORDER BY n % 2, n",
);
parity(
  "distinct on key not in select list",
  events,
  "SELECT DISTINCT ON (user_id) kind, at FROM events ORDER BY user_id, at DESC",
);
parity(
  "distinct on with where",
  events,
  "SELECT DISTINCT ON (user_id) user_id, at FROM events WHERE at > 4 ORDER BY user_id, at DESC",
);
parity(
  "distinct on with limit",
  events,
  "SELECT DISTINCT ON (user_id) user_id, at FROM events ORDER BY user_id, at DESC LIMIT 2",
);
parity(
  "distinct on with nulls in key",
  ["CREATE TABLE t (k int, v int)", "INSERT INTO t VALUES (NULL, 1), (NULL, 2), (1, 3)"],
  "SELECT DISTINCT ON (k) k, v FROM t ORDER BY k NULLS LAST, v",
);
parity(
  "distinct on single row per key already",
  ["CREATE TABLE t (k int, v int)", "INSERT INTO t VALUES (1, 10), (2, 20)"],
  "SELECT DISTINCT ON (k) k, v FROM t ORDER BY k, v",
);
