import { parity } from "../helpers.ts";

const words = [
  "CREATE TABLE words(value TEXT COLLATE NOCASE)",
  "INSERT INTO words VALUES ('Apple'),('banana'),('cherry')",
];

parity(
  "declared column COLLATE NOCASE applies to equality",
  words,
  "SELECT count(*) AS n FROM words WHERE value = 'apple'",
);

parity(
  "declared column COLLATE NOCASE applies to ORDER BY",
  ["CREATE TABLE words(value TEXT COLLATE NOCASE)", "INSERT INTO words VALUES ('banana'),('Apple'),('cherry')"],
  "SELECT value FROM words ORDER BY value",
);
