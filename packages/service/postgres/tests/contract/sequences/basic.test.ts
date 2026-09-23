import { parity, sequenceParity } from "../helpers.ts";

parity("nextval starts at 1 by default", ["CREATE SEQUENCE s"], "SELECT nextval('s') AS v");

parity(
  "nextval increments by 1 by default",
  ["CREATE SEQUENCE s"],
  "SELECT nextval('s') AS a, nextval('s') AS b, nextval('s') AS c",
);

parity("START WITH sets the first value", ["CREATE SEQUENCE s START WITH 100"], "SELECT nextval('s') AS v");

parity("START shorthand without WITH", ["CREATE SEQUENCE s START 42"], "SELECT nextval('s') AS v");

parity(
  "INCREMENT BY controls the step",
  ["CREATE SEQUENCE s INCREMENT BY 10"],
  "SELECT nextval('s') AS a, nextval('s') AS b",
);

parity(
  "negative INCREMENT counts down from -1",
  ["CREATE SEQUENCE s INCREMENT BY -1"],
  "SELECT nextval('s') AS a, nextval('s') AS b",
);

parity(
  "MINVALUE and MAXVALUE with negative increment",
  ["CREATE SEQUENCE s START WITH 10 INCREMENT BY -2 MINVALUE 0 MAXVALUE 100"],
  "SELECT nextval('s') AS a, nextval('s') AS b",
);

sequenceParity(
  "currval reflects the last nextval in the session",
  ["CREATE SEQUENCE s"],
  [
    { sql: "SELECT nextval('s') AS v", query: true },
    { sql: "SELECT currval('s') AS v", query: true },
    { sql: "SELECT nextval('s') AS v", query: true },
    { sql: "SELECT currval('s') AS v", query: true },
  ],
);

sequenceParity(
  "setval moves the sequence and nextval continues after it",
  ["CREATE SEQUENCE s"],
  [
    { sql: "SELECT setval('s', 50) AS v", query: true },
    { sql: "SELECT nextval('s') AS v", query: true },
  ],
);

sequenceParity(
  "setval with is_called false makes nextval return the value itself",
  ["CREATE SEQUENCE s"],
  [
    { sql: "SELECT setval('s', 10, false) AS v", query: true },
    { sql: "SELECT nextval('s') AS v", query: true },
  ],
);

sequenceParity(
  "setval with is_called true skips the value",
  ["CREATE SEQUENCE s"],
  [
    { sql: "SELECT setval('s', 10, true) AS v", query: true },
    { sql: "SELECT nextval('s') AS v", query: true },
  ],
);

sequenceParity(
  "currval works after setval",
  ["CREATE SEQUENCE s"],
  [
    { sql: "SELECT setval('s', 42) AS v", query: true },
    { sql: "SELECT currval('s') AS v", query: true },
  ],
);

sequenceParity(
  "currval keeps last nextval after setval with is_called false",
  ["CREATE SEQUENCE s START WITH 4 INCREMENT BY 2"],
  [
    { sql: "SELECT nextval('s') AS v", query: true },
    { sql: "SELECT nextval('s') AS v", query: true },
    { sql: "SELECT setval('s', 7, false) AS v", query: true },
    { sql: "SELECT currval('s') AS v", query: true },
  ],
);

sequenceParity(
  "lastval returns the most recent nextval across sequences",
  ["CREATE SEQUENCE s1", "CREATE SEQUENCE s2 START 100"],
  [
    { sql: "SELECT nextval('s1') AS v", query: true },
    { sql: "SELECT lastval() AS v", query: true },
    { sql: "SELECT nextval('s2') AS v", query: true },
    { sql: "SELECT lastval() AS v", query: true },
  ],
);

parity(
  "nextval usable in INSERT as an expression",
  [
    "CREATE SEQUENCE s",
    "CREATE TABLE t (id bigint, v text)",
    "INSERT INTO t VALUES (nextval('s'), 'a'), (nextval('s'), 'b')",
  ],
  "SELECT * FROM t ORDER BY id",
);

parity(
  "nextval as a column DEFAULT",
  [
    "CREATE SEQUENCE s",
    "CREATE TABLE t (id int DEFAULT nextval('s'), v text)",
    "INSERT INTO t (v) VALUES ('a'), ('b')",
  ],
  "SELECT * FROM t ORDER BY id",
);
