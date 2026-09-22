import { parity } from "../helpers.ts";

parity(
  "composite PRIMARY KEY equality uses autoindex (not a full scan)",
  [
    "CREATE TABLE kv (a INTEGER NOT NULL, b INTEGER NOT NULL, v TEXT, PRIMARY KEY (a, b))",
    "INSERT INTO kv VALUES (1, 0, 'x'), (2, 0, 'y'), (50, 0, 'z')",
  ],
  "SELECT v FROM kv WHERE a = 50 AND b = 0",
);

parity(
  "column UNIQUE creates autoindex lookup",
  [
    "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT UNIQUE, name TEXT)",
    "INSERT INTO users(email, name) VALUES ('a@ex.test', 'A'), ('b@ex.test', 'B')",
  ],
  "SELECT name FROM users WHERE email = 'b@ex.test'",
);

parity(
  "LEFT JOIN with nullable keys and secondary index",
  [
    "CREATE TABLE a (id INTEGER PRIMARY KEY, k INTEGER)",
    "CREATE TABLE b (id INTEGER PRIMARY KEY, k INTEGER)",
    "CREATE INDEX idx_b_k ON b(k)",
    "INSERT INTO a VALUES (1, NULL), (2, 2), (3, 3)",
    "INSERT INTO b VALUES (10, NULL), (20, 2), (30, NULL)",
  ],
  "SELECT a.id, b.id AS bid FROM a LEFT JOIN b ON a.k = b.k ORDER BY a.id, bid",
);
