import { parity } from "../helpers.ts";

parity(
  "LEFT JOIN ON equality does not match NULL keys to NULL keys",
  [
    "CREATE TABLE a(id INTEGER PRIMARY KEY, k INTEGER)",
    "CREATE TABLE b(id INTEGER PRIMARY KEY, k INTEGER)",
    "INSERT INTO a VALUES (1, NULL), (2, 2), (3, NULL)",
    "INSERT INTO b VALUES (10, NULL), (20, 2), (30, NULL)",
  ],
  "SELECT a.id, b.id AS bid FROM a LEFT JOIN b ON a.k = b.k ORDER BY a.id, bid",
);

parity(
  "unindexed INNER JOIN on equality uses hash semantics with NULLs non-matching",
  [
    "CREATE TABLE a(id INTEGER PRIMARY KEY, k INTEGER)",
    "CREATE TABLE b(id INTEGER PRIMARY KEY, k INTEGER)",
    "INSERT INTO a VALUES (1, 1), (2, NULL), (3, 3)",
    "INSERT INTO b VALUES (10, 1), (20, NULL), (30, 3)",
  ],
  "SELECT a.id, b.id AS bid FROM a JOIN b ON a.k = b.k ORDER BY a.id, bid",
);
