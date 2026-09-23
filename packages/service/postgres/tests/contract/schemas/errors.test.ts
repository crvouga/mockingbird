import { errorParity, queryErrorParity } from "../helpers.ts";

errorParity(
  "CREATE TABLE in a missing schema fails with 3F000",
  [],
  "CREATE TABLE no_such_schema.t (id int)",
  "undefined_object",
);

queryErrorParity(
  "SELECT from a table in a missing schema fails with 42P01",
  [],
  "SELECT * FROM no_such_schema.t",
  "undefined_table",
);

errorParity(
  "INSERT into a table in a missing schema fails with 42P01",
  [],
  "INSERT INTO no_such_schema.t VALUES (1)",
  "undefined_table",
);

errorParity("duplicate schema fails with 42P06", ["CREATE SCHEMA app"], "CREATE SCHEMA app", "duplicate_object");

errorParity("DROP SCHEMA of a missing schema fails with 3F000", [], "DROP SCHEMA no_such_schema", "undefined_object");

queryErrorParity(
  "SELECT missing table in an existing schema fails with 42P01",
  ["CREATE SCHEMA app"],
  "SELECT * FROM app.no_such_table",
  "undefined_table",
);

errorParity(
  "CREATE SEQUENCE in a missing schema fails with 3F000",
  [],
  "CREATE SEQUENCE no_such_schema.s",
  "undefined_object",
);

errorParity(
  "duplicate table within the same schema fails with 42P07",
  ["CREATE SCHEMA app", "CREATE TABLE app.t (id int)"],
  "CREATE TABLE app.t (id int)",
  "duplicate_object",
);
