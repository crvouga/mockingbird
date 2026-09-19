import { errorParity, queryErrorParity, sequenceParity } from "../helpers.ts";

queryErrorParity("currval before nextval fails with 55000", ["CREATE SEQUENCE s"], "SELECT currval('s')", "other");

queryErrorParity("lastval before any nextval fails with 55000", [], "SELECT lastval()", "other");

queryErrorParity(
  "ascending sequence exhaustion fails with 2200H",
  ["CREATE SEQUENCE s MAXVALUE 2", "SELECT nextval('s')", "SELECT nextval('s')"],
  "SELECT nextval('s')",
  "data_exception",
);

queryErrorParity(
  "descending sequence exhaustion fails with 2200H",
  ["CREATE SEQUENCE s INCREMENT BY -1 MINVALUE 3 MAXVALUE 5 START 4", "SELECT nextval('s')", "SELECT nextval('s')"],
  "SELECT nextval('s')",
  "data_exception",
);

sequenceParity(
  "exhausted NO CYCLE sequence keeps failing but currval still works",
  ["CREATE SEQUENCE s MAXVALUE 2"],
  [
    { sql: "SELECT nextval('s') AS a, nextval('s') AS b", query: true },
    { sql: "SELECT nextval('s')", query: true },
    { sql: "SELECT nextval('s')", query: true },
    { sql: "SELECT currval('s') AS v", query: true },
  ],
);

queryErrorParity(
  "nextval of a missing sequence fails with 42P01",
  [],
  "SELECT nextval('no_such_seq')",
  "undefined_table",
);

queryErrorParity(
  "currval of a missing sequence fails with 42P01",
  [],
  "SELECT currval('no_such_seq')",
  "undefined_table",
);

queryErrorParity(
  "setval of a missing sequence fails with 42P01",
  [],
  "SELECT setval('no_such_seq', 1)",
  "undefined_table",
);

errorParity(
  "ALTER SEQUENCE of a missing sequence fails with 42P01",
  [],
  "ALTER SEQUENCE no_such_seq RESTART",
  "undefined_table",
);

errorParity("DROP SEQUENCE of a missing sequence fails", [], "DROP SEQUENCE no_such_seq", "undefined_table");

errorParity("duplicate sequence name fails with 42P07", ["CREATE SEQUENCE s"], "CREATE SEQUENCE s", "duplicate_object");

errorParity(
  "sequence name colliding with a table fails with 42P07",
  ["CREATE TABLE s (id int)"],
  "CREATE SEQUENCE s",
  "duplicate_object",
);

queryErrorParity(
  "setval outside sequence bounds fails with 22003",
  ["CREATE SEQUENCE s MINVALUE 1 MAXVALUE 10"],
  "SELECT setval('s', 99)",
  "numeric_out_of_range",
);
