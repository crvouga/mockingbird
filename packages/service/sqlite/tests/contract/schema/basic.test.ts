import { parity } from "../helpers.ts";

const schema = [
  "CREATE TABLE zebra(id INTEGER)",
  "CREATE TABLE alpha(id INTEGER)",
  "CREATE INDEX alpha_id ON alpha(id)",
  "CREATE VIEW alpha_view AS SELECT id FROM alpha",
];
parity(
  "sqlite_master lists schema objects in name order",
  schema,
  "SELECT type,name,tbl_name FROM sqlite_master ORDER BY name",
);
parity("sqlite_schema aliases sqlite_master", schema, "SELECT type,name,tbl_name FROM sqlite_schema ORDER BY name");
parity("sqlite_master can filter tables", schema, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
parity(
  "index metadata names its owning table",
  schema,
  "SELECT type,name,tbl_name FROM sqlite_master WHERE type='index' ORDER BY name",
);
parity("view metadata names the view table", schema, "SELECT type,name,tbl_name FROM sqlite_schema WHERE type='view'");
