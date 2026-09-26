import { errorParity, parity, sequenceParity } from "../helpers.ts";

parity(
  "BEFORE INSERT trigger runs before the row is stored",
  [
    "CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT)",
    "CREATE TABLE log(msg TEXT)",
    "CREATE TRIGGER before_item BEFORE INSERT ON items BEGIN INSERT INTO log VALUES ('before:'||NEW.name); END",
    "INSERT INTO items VALUES (1,'alpha')",
  ],
  "SELECT msg FROM log",
);

sequenceParity(
  "UPDATE OF trigger fires only for named columns",
  [
    "CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT,score INTEGER)",
    "CREATE TABLE log(msg TEXT)",
    "INSERT INTO items VALUES (1,'alpha',1)",
    "CREATE TRIGGER name_update AFTER UPDATE OF name ON items BEGIN INSERT INTO log VALUES (OLD.name||'>'||NEW.name); END",
  ],
  [
    { sql: "UPDATE items SET score=2 WHERE id=1" },
    { sql: "UPDATE items SET name='beta' WHERE id=1" },
    { sql: "SELECT msg FROM log", query: true },
  ],
);

errorParity(
  "RAISE ABORT stops a triggering statement",
  [
    "CREATE TABLE items(name TEXT)",
    "CREATE TRIGGER reject_item BEFORE INSERT ON items WHEN NEW.name='bad' BEGIN SELECT RAISE(ABORT,'bad item'); END",
  ],
  "INSERT INTO items VALUES ('bad')",
);

sequenceParity(
  "RAISE IGNORE skips the current row",
  [
    "CREATE TABLE items(name TEXT)",
    "CREATE TRIGGER ignore_item BEFORE INSERT ON items WHEN NEW.name='skip' BEGIN SELECT RAISE(IGNORE); END",
  ],
  [
    { sql: "INSERT INTO items VALUES ('keep'),('skip'),('also keep')" },
    { sql: "SELECT name FROM items ORDER BY rowid", query: true },
  ],
);
