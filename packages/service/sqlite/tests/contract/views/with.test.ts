import { errorParity, parity } from "../helpers.ts";

parity(
  "view with CTE in definition",
  [
    "CREATE TABLE items(id INTEGER, name TEXT, active INTEGER)",
    "INSERT INTO items VALUES (1,'a',1),(2,'b',0),(3,'c',1)",
    "CREATE VIEW active_items AS WITH a AS (SELECT id, name FROM items WHERE active=1) SELECT * FROM a",
  ],
  "SELECT id, name FROM active_items ORDER BY id",
);

parity(
  "view with CTE and join",
  [
    "CREATE TABLE t(id INTEGER, g INTEGER)",
    "CREATE TABLE u(id INTEGER, label TEXT)",
    "INSERT INTO t VALUES (1,10),(2,20)",
    "INSERT INTO u VALUES (10,'x'),(20,'y')",
    `CREATE VIEW v AS WITH base AS (SELECT id, g FROM t) SELECT base.id, u.label FROM base JOIN u ON u.id = base.g`,
  ],
  "SELECT id, label FROM v ORDER BY id",
);

errorParity(
  "INSERT into view without INSTEAD OF is rejected",
  ["CREATE TABLE items(id INTEGER, name TEXT)", "CREATE VIEW names AS SELECT name FROM items"],
  "INSERT INTO names VALUES ('z')",
);

errorParity(
  "UPDATE view without INSTEAD OF is rejected",
  [
    "CREATE TABLE items(id INTEGER, name TEXT)",
    "INSERT INTO items VALUES (1,'a')",
    "CREATE VIEW names AS SELECT id, name FROM items",
  ],
  "UPDATE names SET name='b' WHERE id=1",
);
