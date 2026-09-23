import { parity, sequenceParity } from "../helpers.ts";

parity(
  "PRAGMA table_info lists columns",
  ["CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT NOT NULL)"],
  "PRAGMA table_info(people)",
);

parity("PRAGMA database_list includes main", [], "PRAGMA database_list");

sequenceParity(
  "PRAGMA user_version get/set",
  [],
  [{ sql: "PRAGMA user_version = 7" }, { sql: "PRAGMA user_version", query: true }],
);
