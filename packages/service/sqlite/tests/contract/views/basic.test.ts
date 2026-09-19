import { errorParity, parity, sequenceParity } from "../helpers.ts";

const schema = [
  "CREATE TABLE items(id INTEGER,name TEXT,active INTEGER)",
  "INSERT INTO items VALUES (1,'a',1),(2,'b',0),(3,'c',1)",
];

parity(
  "view selects from base table",
  [...schema, "CREATE VIEW active_items AS SELECT id,name FROM items WHERE active=1"],
  "SELECT * FROM active_items ORDER BY id",
);
parity(
  "view reflects later base-table changes",
  [...schema, "CREATE VIEW names AS SELECT name FROM items", "INSERT INTO items VALUES (4,'d',1)"],
  "SELECT * FROM names ORDER BY name",
);
sequenceParity(
  "view may be dropped",
  [...schema, "CREATE VIEW v AS SELECT id FROM items"],
  [{ sql: "DROP VIEW v" }, { sql: "SELECT name FROM sqlite_master WHERE type='view' AND name='v'", query: true }],
);
errorParity(
  "querying dropped view reports missing table",
  [...schema, "CREATE VIEW v AS SELECT id FROM items", "DROP VIEW v"],
  "SELECT * FROM v",
  "no_such_table",
);
