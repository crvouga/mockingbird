import { parity, sequenceParity } from "../helpers.ts";

const schema = [
  "CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT)",
  "CREATE TABLE log(id INTEGER PRIMARY KEY AUTOINCREMENT, msg TEXT)",
];

parity(
  "AFTER INSERT trigger logs inserted row",
  [
    ...schema,
    "CREATE TRIGGER items_log AFTER INSERT ON items BEGIN INSERT INTO log(msg) VALUES ('inserted:' || NEW.name); END",
    "INSERT INTO items(name) VALUES ('alpha')",
  ],
  "SELECT msg FROM log",
);

parity(
  "WHEN clause limits trigger execution",
  [
    ...schema,
    "CREATE TRIGGER items_when AFTER INSERT ON items WHEN NEW.name = 'fire' BEGIN INSERT INTO log(msg) VALUES ('when'); END",
    "INSERT INTO items(name) VALUES ('skip'),('fire'),('skip2')",
  ],
  "SELECT msg FROM log ORDER BY id",
);

sequenceParity(
  "DROP TRIGGER removes trigger from schema",
  [...schema, "CREATE TRIGGER items_log AFTER INSERT ON items BEGIN INSERT INTO log(msg) VALUES ('x'); END"],
  [
    { sql: "DROP TRIGGER items_log" },
    { sql: "SELECT name FROM sqlite_master WHERE type='trigger' AND name='items_log'", query: true },
    { sql: "INSERT INTO items(name) VALUES ('after_drop')" },
    { sql: "SELECT COUNT(*) AS c FROM log", query: true },
  ],
);
