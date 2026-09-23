import { parity, sequenceParity } from "../helpers.ts";

const table = ["CREATE TABLE items(id INTEGER, name TEXT, qty INTEGER DEFAULT 7)"];

sequenceParity("insert and select one row", table, [
  { sql: "INSERT INTO items VALUES (1, 'apple', 3)" },
  { sql: "SELECT * FROM items", query: true },
]);
parity(
  "multiple VALUES rows preserve insertion order",
  [...table, "INSERT INTO items(id,name,qty) VALUES (1,'a',2),(2,'b',4),(3,'c',6)"],
  "SELECT * FROM items ORDER BY rowid",
);
parity(
  "column lists apply defaults and preserve table column order",
  [...table, "INSERT INTO items(name,id) VALUES ('pear',9)"],
  "SELECT * FROM items",
);
parity(
  "omitted nullable columns become NULL",
  [...table, "INSERT INTO items(id) VALUES (4)"],
  "SELECT id,name,qty FROM items",
);
