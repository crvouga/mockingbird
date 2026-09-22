import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "table becomes invisible when its schema leaves the search_path",
  ["CREATE TABLE pub_t (id int)", "CREATE SCHEMA other"],
  [{ sql: "SET search_path TO other" }, { sql: "SELECT * FROM pub_t", query: true }],
);

sequenceParity(
  "pg_catalog builtins remain visible regardless of search_path",
  ["CREATE SCHEMA lonely"],
  [
    { sql: "SET search_path TO lonely" },
    { sql: "SELECT lower('ABC') AS lo, upper('x') AS up, length('abc') AS len", query: true },
  ],
);

sequenceParity(
  "pg_catalog tables remain visible regardless of search_path",
  ["CREATE SCHEMA lonely", "CREATE TABLE lonely.t (id int)"],
  [
    { sql: "SET search_path TO lonely" },
    { sql: "SELECT count(*) AS n FROM pg_class WHERE relname = 't'", query: true },
  ],
);

sequenceParity(
  "user function resolved through the search_path",
  ["CREATE SCHEMA util", "CREATE FUNCTION util.tripled(x int) RETURNS int LANGUAGE sql AS $$ SELECT x * 3 $$"],
  [{ sql: "SET search_path TO util, public" }, { sql: "SELECT tripled(3) AS v", query: true }],
);

sequenceParity(
  "user function not visible when schema is off the path",
  ["CREATE SCHEMA util", "CREATE FUNCTION util.shout(msg text) RETURNS text LANGUAGE sql AS $$ SELECT msg || '!' $$"],
  [
    { sql: "SET search_path TO public" },
    { sql: "SELECT shout('hi'::text)", query: true },
    { sql: "SELECT util.shout('hi'::text) AS v", query: true },
  ],
);

sequenceParity(
  "empty search_path leaves no current schema",
  [],
  [{ sql: "SET search_path TO ''" }, { sql: "SELECT current_schema() IS NULL AS no_schema", query: true }],
);

sequenceParity(
  "sequence resolved through the search_path",
  ["CREATE SCHEMA sq", "CREATE SEQUENCE sq.counter START 10"],
  [{ sql: "SET search_path TO sq, public" }, { sql: "SELECT nextval('counter') AS v", query: true }],
);
