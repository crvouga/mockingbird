import { parity, sequenceParity } from "../helpers.ts";

parity(
  "CYCLE wraps to MINVALUE after MAXVALUE",
  ["CREATE SEQUENCE s MAXVALUE 2 CYCLE"],
  "SELECT nextval('s') AS a, nextval('s') AS b, nextval('s') AS c",
);

parity(
  "CYCLE with explicit MINVALUE",
  ["CREATE SEQUENCE s MINVALUE 5 MAXVALUE 6 START 5 CYCLE"],
  "SELECT nextval('s') AS a, nextval('s') AS b, nextval('s') AS c",
);

parity(
  "descending CYCLE wraps to MAXVALUE after MINVALUE",
  ["CREATE SEQUENCE s INCREMENT BY -1 MINVALUE 1 MAXVALUE 3 START 2 CYCLE"],
  "SELECT nextval('s') AS a, nextval('s') AS b, nextval('s') AS c",
);

parity("CACHE clause is accepted", ["CREATE SEQUENCE s CACHE 10"], "SELECT nextval('s') AS a, nextval('s') AS b");

parity(
  "NO CYCLE NO MINVALUE NO MAXVALUE clauses accepted",
  ["CREATE SEQUENCE s NO CYCLE NO MINVALUE NO MAXVALUE"],
  "SELECT nextval('s') AS v",
);

parity("AS smallint bounds the sequence type", ["CREATE SEQUENCE s AS smallint"], "SELECT nextval('s') AS v");

sequenceParity(
  "ALTER SEQUENCE INCREMENT BY changes the step",
  ["CREATE SEQUENCE s"],
  [
    { sql: "SELECT nextval('s') AS v", query: true },
    { sql: "ALTER SEQUENCE s INCREMENT BY 5" },
    { sql: "SELECT nextval('s') AS v", query: true },
  ],
);

sequenceParity(
  "ALTER SEQUENCE RESTART resets to the start value",
  ["CREATE SEQUENCE s"],
  [
    { sql: "SELECT nextval('s') AS a, nextval('s') AS b", query: true },
    { sql: "ALTER SEQUENCE s RESTART" },
    { sql: "SELECT nextval('s') AS v", query: true },
  ],
);

sequenceParity(
  "ALTER SEQUENCE RESTART WITH a specific value",
  ["CREATE SEQUENCE s"],
  [
    { sql: "SELECT nextval('s') AS v", query: true },
    { sql: "ALTER SEQUENCE s RESTART WITH 500" },
    { sql: "SELECT nextval('s') AS v", query: true },
  ],
);

sequenceParity(
  "DROP SEQUENCE removes it from pg_class",
  ["CREATE SEQUENCE s"],
  [
    { sql: "SELECT count(*) AS n FROM pg_class WHERE relname = 's'", query: true },
    { sql: "DROP SEQUENCE s" },
    { sql: "SELECT count(*) AS n FROM pg_class WHERE relname = 's'", query: true },
  ],
);

parity(
  "information_schema.sequences reports options",
  ["CREATE SEQUENCE s START 5 INCREMENT BY 3"],
  "SELECT sequence_name, start_value, increment FROM information_schema.sequences WHERE sequence_name = 's'",
);

parity(
  "pg_sequences view reports the sequence",
  ["CREATE SEQUENCE s START 3"],
  "SELECT schemaname, sequencename, start_value FROM pg_sequences WHERE sequencename = 's'",
);

parity(
  "sequence appears in pg_class with relkind S",
  ["CREATE SEQUENCE s"],
  "SELECT relname, relkind FROM pg_class WHERE relname = 's'",
);
