import { parity, sequenceParity } from "../helpers.ts";

const textData = [
  "CREATE TABLE words(value TEXT)",
  "INSERT INTO words VALUES ('banana'),('Apple'),('cherry'),('apple')",
];

parity("ORDER BY applies NOCASE collation", textData, "SELECT value FROM words ORDER BY value COLLATE NOCASE, value");

parity("equality applies explicit NOCASE collation", [], "SELECT 'a' = 'A' COLLATE NOCASE AS equal");

parity("RTRIM ignores trailing spaces", [], "SELECT 'abc' = 'abc  ' COLLATE RTRIM AS equal");

parity(
  "GROUP BY applies explicit NOCASE collation",
  ["CREATE TABLE words(value TEXT)", "INSERT INTO words VALUES ('aa'),('AA'),('x')"],
  "SELECT value COLLATE NOCASE AS key, count(*) AS n FROM words GROUP BY key ORDER BY key, min(rowid)",
);

parity(
  "BINARY comparison remains case-sensitive",
  [],
  "SELECT 'a' = 'A' AS equal, 'a' = 'A' COLLATE BINARY AS explicit_equal",
);

sequenceParity(
  "UNIQUE index applies NOCASE collation",
  ["CREATE TABLE tags(value TEXT)", "CREATE UNIQUE INDEX tags_value_nocase ON tags(value COLLATE NOCASE)"],
  [
    { sql: "INSERT INTO tags VALUES ('alpha')" },
    { sql: "INSERT OR IGNORE INTO tags VALUES ('ALPHA')" },
    { sql: "SELECT value FROM tags", query: true },
  ],
);
